import type { DatabaseSync } from 'node:sqlite';
import { nativeCatalogSql } from './catalog-sql.js';
import { basename, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { directoryKey } from './directories.js';
import type { DocumentSort, SourceIssueKind } from './store.js';

export interface CatalogScope { tagId?: string | null; directory?: string | null; issues?: boolean; hideUnsupported?: boolean; indexedOnly?: boolean }
export interface CatalogRow {
  file_id: string; relative_path: string; doc_id: string | null; issue_kind: SourceIssueKind | null; reason: string;
  document_name: string | null; hash: string | null; added_at: number; indexed_at: number; chunks: number | null;
  size_bytes: number | null; modified_at: number | null; type_key: string; revision: number;
}
interface Cursor { scope: string; key: string | number; known: number; id: string }

/** A separately versioned, incrementally maintained file catalogue. No filesystem or vector reads. */
export class SourceCatalog {
  constructor(private readonly db: DatabaseSync, private readonly root: string) {
    const existing=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_catalog_meta'").get();
    if(existing){const version=db.prepare('SELECT schema_version FROM source_catalog_meta WHERE id=1').get() as {schema_version:number}|undefined;if(version&&version.schema_version!==1)throw new Error('Unsupported source catalogue schema.');}
    const exec=(sql:string)=>this.exec(sql);
    const key = (value: unknown) => process.platform === 'win32' ? String(value).toLowerCase() : String(value);
    const slash = (value: unknown) => value==null?null:String(value).split(sep).join('/');
    db.function('catalog_key', { deterministic: true }, key);
    db.function('catalog_slash', { deterministic: true }, slash);
    db.function('catalog_relative', value => value==null?null:relative(root, String(value)).split(sep).join('/'));
    db.function('catalog_base', { deterministic: true }, value => String(value).split('/').at(-1) ?? '');
    db.function('catalog_parent', { deterministic: true }, value => String(value).split('/').slice(0, -1).join('/'));
    db.function('catalog_sort', { deterministic: true }, value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase());
    db.function('catalog_type', { deterministic: true }, value => {
      const extension = String(value).split('/').at(-1)?.split('.').slice(1).at(-1)?.toLowerCase() ?? '';
      return ({ jpg: 'jpeg', tif: 'tiff', markdown: 'md' } as Record<string, string>)[extension] ?? extension;
    });
    db.function('catalog_ancestors', { deterministic: true }, value => {
      const parts = key(value).split('/'), paths = [''];
      for (let i = 1; i < parts.length; i++) paths.push(parts.slice(0, i).join('/'));
      return JSON.stringify(paths);
    });
    exec(`CREATE TABLE IF NOT EXISTS source_catalog_meta(id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS source_files(
        file_id TEXT PRIMARY KEY DEFAULT(lower(hex(randomblob(16)))), path_key TEXT NOT NULL UNIQUE, relative_path TEXT NOT NULL,
        doc_id TEXT, content_hash TEXT, issue_kind TEXT, reason TEXT NOT NULL DEFAULT '', name_key TEXT NOT NULL, type_key TEXT NOT NULL,
        added_at INTEGER NOT NULL DEFAULT 0, indexed_at INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER, modified_at REAL,
        size_known INTEGER GENERATED ALWAYS AS (size_bytes IS NOT NULL) STORED,
        size_key INTEGER GENERATED ALWAYS AS (coalesce(size_bytes,0)) STORED,
        modified_known INTEGER GENERATED ALWAYS AS (modified_at IS NOT NULL) STORED,
        modified_key REAL GENERATED ALWAYS AS (coalesce(modified_at,0)) STORED,
        normal INTEGER GENERATED ALWAYS AS (issue_kind IS NULL OR issue_kind='pending') STORED,
        last_seen TEXT, revision INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS source_files_doc ON source_files(doc_id);
      CREATE TABLE IF NOT EXISTS source_directories(path TEXT PRIMARY KEY,parent TEXT,name TEXT NOT NULL,all_count INTEGER NOT NULL DEFAULT 0,normal_count INTEGER NOT NULL DEFAULT 0,unsupported_count INTEGER NOT NULL DEFAULT 0,explicit_count INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO source_directories(path,parent,name) VALUES('',NULL,'');
      CREATE TABLE IF NOT EXISTS source_scan_runs(id TEXT PRIMARY KEY,root_dev TEXT NOT NULL,root_ino TEXT NOT NULL,state TEXT NOT NULL,discovered INTEGER NOT NULL DEFAULT 0,started_at INTEGER NOT NULL,finished_at INTEGER);
      CREATE INDEX IF NOT EXISTS source_scan_seen ON source_files(last_seen,path_key);
      CREATE TABLE IF NOT EXISTS source_scan_directories(run_id TEXT NOT NULL,path TEXT NOT NULL,complete INTEGER NOT NULL,PRIMARY KEY(run_id,path));`);
    if (!(db.prepare('PRAGMA table_info(documents)').all() as Array<{name: string}>).some(row => row.name === 'source_key')) {
      exec('ALTER TABLE documents ADD COLUMN source_key TEXT');
    }
    exec(`CREATE INDEX IF NOT EXISTS documents_source_key ON documents(source_key,indexed_at DESC);
      CREATE INDEX IF NOT EXISTS source_issues_key ON source_issues(catalog_key(path));
      CREATE INDEX IF NOT EXISTS source_folders_key ON source_folders(catalog_key(path));`);
    this.installTriggers();
    const migration = db.prepare('SELECT schema_version FROM source_catalog_meta WHERE id=1').get() as {schema_version: number} | undefined;
    if (migration && migration.schema_version !== 1) throw new Error('Unsupported source catalogue schema.');
    if (!migration) {
      exec('BEGIN IMMEDIATE');
      try {
        exec(`INSERT INTO source_catalog_meta VALUES(1,1,0);
          UPDATE documents SET source_key=catalog_key(catalog_slash(coalesce(relative_path,catalog_relative(path))));`);
        if(process.platform==='win32'){
          const update=db.prepare('UPDATE documents SET source_key=? WHERE id=?');
          for(const row of db.prepare('SELECT id,path,relative_path FROM documents').all() as Array<{id:string;path:string;relative_path:string|null}>)update.run(key(slash(row.relative_path??relative(root,row.path))),row.id);
          for(const table of ['source_folders','source_issues']){
            const rows=db.prepare(`SELECT * FROM ${table}`).all() as Array<{path:string;kind?:string;reason?:string}>;
            for(const row of rows){const canonical=key(row.path);if(row.path===canonical)continue;db.prepare(`DELETE FROM ${table} WHERE path=?`).run(row.path);
              if(table==='source_folders')db.prepare('INSERT OR IGNORE INTO source_folders VALUES(?)').run(canonical);
              else db.prepare('INSERT INTO source_issues VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET kind=excluded.kind,reason=excluded.reason').run(canonical,row.kind!,row.reason!);
            }
          }
        }
        const seed = db.prepare(nativeCatalogSql(this.project('?'),root));
        // Only the one-time migration enumerates old records. All subsequent pages are indexed SQL.
        const paths = db.prepare(`SELECT source_key AS path FROM documents UNION SELECT catalog_key(path) FROM source_issues WHERE path<>''`).all() as Array<{path: string}>;
        for (const {path} of paths) { directoryKey(path); seed.run(path); }
        exec(`CREATE TEMP TABLE migration_folder_counts(path TEXT PRIMARY KEY,n INTEGER NOT NULL);
          INSERT INTO migration_folder_counts SELECT value,count(*) FROM source_folders sf,json_each(catalog_ancestors(sf.path||'/x')) GROUP BY value;
          INSERT INTO source_directories(path,parent,name) SELECT path,CASE WHEN path='' THEN NULL ELSE catalog_parent(path) END,catalog_base(path) FROM migration_folder_counts WHERE 1 ON CONFLICT(path) DO NOTHING;
          UPDATE source_directories SET explicit_count=coalesce((SELECT n FROM migration_folder_counts m WHERE m.path=source_directories.path),0);
          DROP TABLE migration_folder_counts; COMMIT`);
      } catch (error) { exec('ROLLBACK'); throw error; }
    }
    this.installIndexes();
  }

  private project(key: string): string {
    return `INSERT INTO source_files(file_id,path_key,relative_path,doc_id,content_hash,issue_kind,reason,name_key,type_key,added_at,indexed_at,size_bytes,modified_at)
      SELECT coalesce(d.id,lower(hex(randomblob(16)))),s.k,coalesce(catalog_slash(d.relative_path),catalog_relative(d.path),i.path),d.id,d.hash,i.kind,coalesce(i.reason,''),
        catalog_sort(coalesce(d.name,catalog_base(i.path))),coalesce(m.file_type,catalog_type(coalesce(d.relative_path,i.path,catalog_relative(d.path)))),
        coalesce(d.added_at,0),coalesce(d.indexed_at,0),m.size_bytes,m.modified_at
      FROM (SELECT ${key} AS k) s
      LEFT JOIN documents d ON d.id=(SELECT id FROM documents WHERE source_key=s.k ORDER BY indexed_at DESC,id DESC LIMIT 1)
      LEFT JOIN source_issues i ON catalog_key(i.path)=s.k
      LEFT JOIN source_metadata m ON m.path=s.k
      WHERE (d.id IS NOT NULL OR i.path IS NOT NULL) AND s.k<>''
        AND NOT EXISTS(SELECT 1 FROM source_folders WHERE catalog_key(path)=s.k)
      ON CONFLICT(path_key) DO UPDATE SET relative_path=excluded.relative_path,doc_id=excluded.doc_id,content_hash=excluded.content_hash,issue_kind=excluded.issue_kind,
        reason=excluded.reason,name_key=excluded.name_key,type_key=excluded.type_key,added_at=excluded.added_at,indexed_at=excluded.indexed_at,
        size_bytes=excluded.size_bytes,modified_at=excluded.modified_at,revision=source_files.revision+1
      WHERE source_files.doc_id IS NOT excluded.doc_id OR source_files.content_hash IS NOT excluded.content_hash OR source_files.issue_kind IS NOT excluded.issue_kind
        OR source_files.relative_path IS NOT excluded.relative_path OR source_files.reason IS NOT excluded.reason
        OR source_files.name_key IS NOT excluded.name_key OR source_files.type_key IS NOT excluded.type_key
        OR source_files.added_at IS NOT excluded.added_at OR source_files.indexed_at IS NOT excluded.indexed_at
        OR source_files.size_bytes IS NOT excluded.size_bytes OR source_files.modified_at IS NOT excluded.modified_at;`;
  }
  private prune(key: string): string {
    return `DELETE FROM source_files WHERE path_key=${key} AND NOT EXISTS(SELECT 1 FROM documents WHERE source_key=${key})
      AND NOT EXISTS(SELECT 1 FROM source_issues WHERE catalog_key(path)=${key});`;
  }
  private directoryDelta(row: 'NEW' | 'OLD', sign: 1 | -1): string {
    return `INSERT INTO source_directories(path,parent,name)
      SELECT value,CASE WHEN value='' THEN NULL ELSE catalog_parent(value) END,catalog_base(value) FROM json_each(catalog_ancestors(${row}.path_key)) WHERE 1 ON CONFLICT(path) DO NOTHING;
      UPDATE source_directories SET all_count=all_count+(${sign}),normal_count=normal_count+(${sign})*${row}.normal,
        unsupported_count=unsupported_count+(${sign})*coalesce(${row}.issue_kind='unsupported',0)
      WHERE path IN(SELECT value FROM json_each(catalog_ancestors(${row}.path_key)));`;
  }
  private exec(sql:string):void { this.db.exec(nativeCatalogSql(sql,this.root)); }
  private installTriggers(): void {
    const exec=(sql:string)=>this.exec(sql);
    for (const action of ['INSERT', 'UPDATE'] as const) {
      const fallback='catalog_key(catalog_slash(coalesce(NEW.relative_path,catalog_relative(NEW.path))))';
      const key=action==='UPDATE'?`CASE WHEN NEW.relative_path IS NOT OLD.relative_path AND NEW.source_key IS OLD.source_key THEN ${fallback} ELSE coalesce(NEW.source_key,${fallback}) END`:`coalesce(NEW.source_key,${fallback})`;
      exec(`CREATE TRIGGER IF NOT EXISTS catalog_document_${action.toLowerCase()} AFTER ${action}${action==='UPDATE'?' OF path,relative_path,name,hash,added_at,indexed_at,chunks':''} ON documents BEGIN
        UPDATE documents SET source_key=${key} WHERE id=NEW.id;
        ${action==='UPDATE'?`DELETE FROM source_files WHERE path_key=(${key}) AND doc_id IS NULL AND EXISTS(SELECT 1 FROM source_files WHERE doc_id=OLD.id);
          UPDATE source_files SET path_key=${key},relative_path=catalog_slash(coalesce(NEW.relative_path,catalog_relative(NEW.path))) WHERE doc_id=OLD.id AND path_key<>(${key});`:''}
        ${this.project(key)}
        ${action==='UPDATE'?this.project('OLD.source_key')+this.prune('OLD.source_key'):''}
      END;`);
      exec(`CREATE TRIGGER IF NOT EXISTS catalog_issue_${action.toLowerCase()} AFTER ${action} ON source_issues BEGIN ${this.project('catalog_key(NEW.path)')} END;`);
    }
    exec(`CREATE TRIGGER IF NOT EXISTS catalog_document_delete AFTER DELETE ON documents BEGIN ${this.project('OLD.source_key')} ${this.prune('OLD.source_key')} END;
      CREATE TRIGGER IF NOT EXISTS catalog_issue_delete AFTER DELETE ON source_issues BEGIN ${this.project('catalog_key(OLD.path)')} ${this.prune('catalog_key(OLD.path)')} END;
      CREATE TRIGGER IF NOT EXISTS catalog_metadata_insert AFTER INSERT ON source_metadata BEGIN
        UPDATE source_files SET size_bytes=NEW.size_bytes,modified_at=NEW.modified_at,type_key=NEW.file_type,revision=revision+1 WHERE path_key=NEW.path
        AND (size_bytes IS NOT NEW.size_bytes OR modified_at IS NOT NEW.modified_at OR type_key IS NOT NEW.file_type); END;
      CREATE TRIGGER IF NOT EXISTS catalog_file_insert AFTER INSERT ON source_files BEGIN ${this.directoryDelta('NEW',1)} UPDATE source_catalog_meta SET version=version+1 WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS catalog_file_delete AFTER DELETE ON source_files BEGIN ${this.directoryDelta('OLD',-1)} UPDATE source_catalog_meta SET version=version+1 WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS catalog_file_counts AFTER UPDATE OF path_key,relative_path,issue_kind ON source_files
        WHEN OLD.path_key IS NOT NEW.path_key OR OLD.relative_path IS NOT NEW.relative_path OR OLD.issue_kind IS NOT NEW.issue_kind BEGIN ${this.directoryDelta('OLD',-1)} ${this.directoryDelta('NEW',1)} END;
      CREATE TRIGGER IF NOT EXISTS catalog_file_version AFTER UPDATE ON source_files BEGIN UPDATE source_catalog_meta SET version=version+1 WHERE id=1; END;`);
    for (const [action,sign,row] of [['INSERT',1,'NEW'],['DELETE',-1,'OLD'],['UPDATE',0,'NEW']] as const) {
      exec(`CREATE TRIGGER IF NOT EXISTS catalog_folder_${action.toLowerCase()} AFTER ${action} ON source_folders ${sign===0?'WHEN OLD.path IS NOT NEW.path':''} BEGIN
        INSERT INTO source_directories(path,parent,name) SELECT value,CASE WHEN value='' THEN NULL ELSE catalog_parent(value) END,catalog_base(value)
          FROM json_each(catalog_ancestors(${row}.path||'/x')) WHERE 1 ON CONFLICT(path) DO NOTHING;
        ${sign?`UPDATE source_directories SET explicit_count=explicit_count+(${sign}) WHERE path IN(SELECT value FROM json_each(catalog_ancestors(${row}.path||'/x')));`
          :`UPDATE source_directories SET explicit_count=explicit_count-1 WHERE path IN(SELECT value FROM json_each(catalog_ancestors(OLD.path||'/x')));
            UPDATE source_directories SET explicit_count=explicit_count+1 WHERE path IN(SELECT value FROM json_each(catalog_ancestors(NEW.path||'/x')));`}
        UPDATE source_catalog_meta SET version=version+1 WHERE id=1;
      END;`);
    }
  }

  private installIndexes(): void {
    for (const [name,columns] of [['name','name_key'],['added','added_at'],['updated','indexed_at'],['type','type_key'],['size','size_key'],['modified','modified_key']] as const) {
      const known = name==='size'?'size_known DESC,':name==='modified'?'modified_known DESC,':'';
      for (const direction of ['ASC','DESC']) {
        this.exec(`CREATE INDEX IF NOT EXISTS source_order_${name}_${direction} ON source_files(${known}${columns} ${direction},file_id ASC);
          CREATE INDEX IF NOT EXISTS source_normal_${name}_${direction} ON source_files(normal,${known}${columns} ${direction},file_id ASC);`);
      }
    }
  }
  get version(): number { return (this.db.prepare('SELECT version FROM source_catalog_meta WHERE id=1').get() as {version:number}).version; }
  private scope(scope: CatalogScope): {where: string; params: Array<string|number>} {
    const clauses: string[] = [], params: Array<string|number> = [];
    if (scope.indexedOnly) clauses.push('f.doc_id IS NOT NULL');
    else if (scope.issues) clauses.push('f.normal=0');
    else if (scope.directory!=null || scope.tagId!=null) clauses.push('f.normal=1');
    if (scope.hideUnsupported) clauses.push("coalesce(f.issue_kind,'')<>'unsupported'");
    if (scope.directory!=null) {
      let path=directoryKey(scope.directory); if(process.platform==='win32')path=path.toLowerCase();
      clauses.push('f.path_key>=? AND f.path_key<?');params.push(`${path}/`,`${path}0`);
    }
    if(scope.tagId==='default')clauses.push('NOT EXISTS(SELECT 1 FROM document_tags dt WHERE dt.document_id=f.doc_id)');
    else if(scope.tagId!=null){clauses.push('EXISTS(SELECT 1 FROM document_tags dt WHERE dt.document_id=f.doc_id AND dt.tag_id=?)');params.push(scope.tagId);}
    return {where:clauses.length?clauses.join(' AND '):'1',params};
  }
  private order(sort: DocumentSort, descending?: boolean) {
    const column=({name:'name_key',added:'added_at',updated:'indexed_at',modified:'modified_key',size:'size_key',type:'type_key'} as const)[sort]??'name_key';
    const reverse=descending??(sort==='added'||sort==='updated'||sort==='size'||sort==='modified');
    const known=sort==='size'?'size_known':sort==='modified'?'modified_known':null;
    return {column,reverse,known,sql:`${known?`f.${known} DESC,`:''}f.${column} ${reverse?'DESC':'ASC'},f.file_id ASC`};
  }
  private count(scope: CatalogScope): number {
    if(!scope.indexedOnly&&scope.directory==null&&scope.tagId==null){const row=this.db.prepare("SELECT all_count,normal_count,unsupported_count FROM source_directories WHERE path=''").get() as {all_count:number;normal_count:number;unsupported_count:number};return row.all_count-(scope.issues?row.normal_count:0)-(scope.hideUnsupported?row.unsupported_count:0);}
    const {where,params}=this.scope(scope);
    return (this.db.prepare(`SELECT count(*) AS n FROM source_files f WHERE ${where}`).get(...params) as {n:number}).n;
  }
  countFiles(hideUnsupported=false): number { return this.count({hideUnsupported}); }
  countIssues(hideUnsupported=false): number { return this.count({issues:true,hideUnsupported}); }
  directories(hideUnsupported=false) {
    return (this.db.prepare(`SELECT path,parent,name,CASE WHEN path='' THEN all_count-${hideUnsupported?'unsupported_count':'0'} ELSE normal_count END AS count
      FROM source_directories WHERE path='' OR all_count>0 OR explicit_count>0 ORDER BY path`).all());
  }
  uncategorizedCount(): number { return this.count({tagId:'default'}); }
  tagRows() {
    return this.db.prepare(`SELECT t.id,t.name,t.color,count(f.file_id) AS count FROM tags t
      LEFT JOIN document_tags dt ON dt.tag_id=t.id LEFT JOIN source_files f ON f.doc_id=dt.document_id AND f.normal=1
      GROUP BY t.id ORDER BY t.sort_order,t.created_at,t.name`).all();
  }
  private fingerprint(scope: CatalogScope,sort:DocumentSort,descending?:boolean): string {
    return createHash('sha256').update(JSON.stringify([this.root,scope.tagId??null,scope.directory??null,!!scope.issues,!!scope.hideUnsupported,!!scope.indexedOnly,sort,descending])).digest('hex');
  }
  private cursor(row: Record<string,unknown>, scope: CatalogScope, sort: DocumentSort, descending?: boolean): string {
    const order=this.order(sort,descending);
    return Buffer.from(JSON.stringify({scope:this.fingerprint(scope,sort,descending),key:row[order.column],known:order.known?row[order.known]:1,id:row.file_id})).toString('base64url');
  }
  private readCursor(value:string,scope:CatalogScope,sort:DocumentSort,descending?:boolean):Cursor {
    if(value.length>4096)throw new Error('Invalid catalogue cursor.');
    let cursor:Cursor;try{cursor=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{throw new Error('Invalid catalogue cursor.');}
    if(cursor.scope!==this.fingerprint(scope,sort,descending)||typeof cursor.id!=='string'||!['string','number'].includes(typeof cursor.key)||![0,1].includes(cursor.known))throw new Error('Catalogue cursor does not belong to this list.');
    return cursor;
  }
  private rowQuery(scope:CatalogScope,sort:DocumentSort,descending:boolean|undefined,offset:number,limit:number,cursor?:string,before=false) {
    const {where,params}=this.scope(scope), order=this.order(sort,descending);
    let range='',ordering=order.sql;
    if(cursor){
      const c=this.readCursor(cursor,scope,sort,descending), relation=(order.reverse!==before)?'<':'>';
      const tie=before?'<':'>';
      const main=`(f.${order.column}${relation}? OR (f.${order.column}=? AND f.file_id${tie}?))`;
      if(order.known){range=` AND (f.${order.known}${before?'>':'<'}? OR (f.${order.known}=? AND ${main}))`;params.push(c.known,c.known,c.key,c.key,c.id);}
      else{range=` AND ${main}`;params.push(c.key,c.key,c.id);}
      if(before)ordering=`${order.known?`f.${order.known} ASC,`:''}f.${order.column} ${order.reverse?'ASC':'DESC'},f.file_id DESC`;
      offset=0;
    }
    const rows=this.db.prepare(`SELECT f.*,d.name AS document_name,d.hash,d.chunks FROM source_files f LEFT JOIN documents d ON d.id=f.doc_id
      WHERE ${where}${range} ORDER BY ${ordering} LIMIT ? OFFSET ?`).all(...params,limit,offset) as unknown as CatalogRow[];
    if(before&&cursor)rows.reverse();return rows;
  }
  private rank(scope:CatalogScope,sort:DocumentSort,descending:boolean|undefined,target:Record<string,unknown>):number {
    const {where,params}=this.scope(scope),order=this.order(sort,descending);
    const main=`(f.${order.column}${order.reverse?'>':'<'}? OR (f.${order.column}=? AND f.file_id<?))`;
    const range=order.known?`(f.${order.known}>? OR (f.${order.known}=? AND ${main}))`:main;
    if(order.known)params.push(target[order.known] as number,target[order.known] as number);
    params.push(target[order.column] as string|number,target[order.column] as string|number,target.file_id as string);
    return (this.db.prepare(`SELECT count(*) AS n FROM source_files f WHERE ${where} AND ${range}`).get(...params) as {n:number}).n;
  }
  position(id:string,scope:CatalogScope,sort:DocumentSort,descending?:boolean):number|null {
    const {where,params}=this.scope(scope);
    const target=this.db.prepare(`SELECT f.* FROM source_files f WHERE ${where} AND (f.doc_id=? OR f.file_id=? OR ('issue:'||f.relative_path)=?) LIMIT 1`).get(...params,id,id,id) as Record<string,unknown>|undefined;
    return target?this.rank(scope,sort,descending,target):null;
  }
  page(scope:CatalogScope,sort:DocumentSort,descending:boolean|undefined,options:{offset?:number;limit?:number;anchorPath?:string;anchorIndex?:number;cursor?:string;before?:boolean;window?:boolean}={}) {
    this.exec('SAVEPOINT catalog_read');
    try{
      const total=this.count(scope),limit=Math.max(1,Math.min(options.window?500:50,Math.floor(options.limit??50)||50));
      let offset=Math.max(0,Math.min(1_000_000,Math.floor(options.offset??0)||0));
      let anchor:Record<string,unknown>|undefined;
      if(options.anchorPath){
        let key=relative(this.root,resolve(options.anchorPath)).split(sep).join('/');if(process.platform==='win32')key=key.toLowerCase();
        const {where,params}=this.scope(scope);anchor=this.db.prepare(`SELECT f.* FROM source_files f WHERE ${where} AND f.path_key=?`).get(...params,key) as Record<string,unknown>|undefined;
        if(anchor)offset=Math.max(0,this.rank(scope,sort,descending,anchor)-Math.max(0,Math.min(limit-1,options.anchorIndex??0)));
      }
      if(options.window)offset=Math.min(offset,Math.max(0,total-limit));
      const rows=this.rowQuery(scope,sort,descending,offset,limit,options.cursor,options.before);
      if(options.cursor&&rows.length)offset=this.rank(scope,sort,descending,rows[0]! as unknown as Record<string,unknown>);
      const catalogVersion=this.version;
      this.exec('RELEASE catalog_read');
      return {rows,total,offset,catalogVersion,
        ...(rows.length?{nextCursor:this.cursor(rows.at(-1)! as unknown as Record<string,unknown>,scope,sort,descending),previousCursor:this.cursor(rows[0]! as unknown as Record<string,unknown>,scope,sort,descending)}:{})};
    }catch(error){this.exec('ROLLBACK TO catalog_read; RELEASE catalog_read');throw error;}
  }
}
