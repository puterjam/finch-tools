# Document status model

The list remains the indexed-document catalogue, not a filesystem browser. Statuses describe a listed document's current usability. New files appear after successful indexing; this change does not invent catalogue entries or manage originals.

| State | Chinese label | Meaning |
| --- | --- | --- |
| processing | 处理中 | An indexing attempt is in progress. |
| ready | 可检索 | The source matches the indexed generation and all expected passages exist. |
| outdated | 待更新 | Source bytes differ from the indexed generation. |
| pending | 待索引 | No passages exist for the catalogue's committed generation. |
| incomplete | 索引不完整 | Only part of the expected generation exists. |
| failed | 处理失败 | The last indexing attempt failed; previously committed data is retained. |
| source_missing | 原文件缺失 | The file is absent while its parent directory remains accessible. |
| source_unavailable | 暂不可访问 | The source, directory or volume cannot safely be read. |
| unverified | 待检查 | Index coverage cannot currently be verified. |

Priority: processing → source missing/unavailable → failed → outdated → pending/incomplete/unverified → ready. Only ready uses the positive accent/check icon; warnings and unknowns never imply successful indexing.

Index coverage requires both document ID and committed content hash. Source checks use SHA-256, with bounded concurrency and a cache keyed by size, modification time and change time. Files changed during verification cannot become ready. Links outside the chosen directory are never read. Failure reasons persist in the private catalogue; transient processing state does not persist across restarts.

Rows update in place during indexing, including AI-initiated attempts, without resetting scroll. Notifications carry the source directory and are ignored after switching libraries; late results from an older attempt cannot overwrite newer progress. Public labels, accessibility text and tooltips do not mention the database engine.

Missing/incomplete indexes can be repaired by scanning unchanged source files. Repairs preserve the document ID and tags. Source access failures preserve existing indexes and never delete or modify originals.
