/** Compile catalogue trigger helpers to SQLite builtins. Persisted triggers must also work in
 * ordinary SQLite connections and older mini-program versions without registered JS functions. */
export function nativeCatalogSql(sql: string, root: string): string {
  const key=(value:string)=>process.platform==='win32'?`lower(${value})`:`(${value})`;
  const slash=(value:string)=>process.platform==='win32'?`replace(${value},char(92),'/')`:`(${value})`;
  const base=(value:string)=>`substr(${value},length(rtrim(${value},replace(${value},'/','')))+1)`;
  const helper=(name:string,arg:string):string=>{
    switch(name){
      case 'key':return key(arg);
      case 'slash':return slash(arg);
      case 'relative':return `substr(${slash(arg)},${root.split('\\').join('/').replace(/\/+$/,'').length+2})`;
      case 'base':return base(arg);
      case 'parent':return `rtrim(substr(${arg},1,length(${arg})-length(${base(arg)})),'/')`;
      case 'sort':return `lower(coalesce(${arg},''))`;
      case 'type':{
        const name=base(arg),ext=`CASE WHEN instr(${name},'.')=0 THEN '' ELSE lower(substr(${name},length(rtrim(${name},replace(${name},'.','')))+1)) END`;
        return `CASE (${ext}) WHEN 'jpg' THEN 'jpeg' WHEN 'tif' THEN 'tiff' WHEN 'markdown' THEN 'md' ELSE (${ext}) END`;
      }
      case 'ancestors':return `(WITH RECURSIVE ancestors(path,rest) AS (SELECT '',${key(arg)}||'/' UNION ALL
        SELECT CASE WHEN path='' THEN substr(rest,1,instr(rest,'/')-1) ELSE path||'/'||substr(rest,1,instr(rest,'/')-1) END,
          substr(rest,instr(rest,'/')+1) FROM ancestors WHERE instr(rest,'/')>0)
        SELECT json_group_array(path) FROM ancestors WHERE rest<>'')`;
      default:throw new Error(`Unknown catalogue SQL helper: ${name}`);
    }
  };
  function compile(input:string):string{
    let output='',i=0;
    while(i<input.length){
      if(input[i]==="'"){
        const start=i++;
        while(i<input.length){if(input[i++]==="'"){if(input[i]==="'"){i++;continue;}break;}}
        output+=input.slice(start,i);continue;
      }
      const match=/^catalog_(key|slash|relative|base|parent|sort|type|ancestors)\(/.exec(input.slice(i));
      if(!match){output+=input[i++];continue;}
      i+=match[0].length;const start=i;let depth=1,quote=false;
      while(i<input.length&&depth){const ch=input[i++];if(ch==="'"){if(quote&&input[i]==="'"){i++;continue;}quote=!quote;}else if(!quote){if(ch==='(')depth++;else if(ch===')')depth--;}}
      if(depth)throw new Error('Unbalanced catalogue SQL helper.');
      output+=helper(match[1]!,compile(input.slice(start,i-1)));
    }
    return output;
  }
  return compile(sql);
}
