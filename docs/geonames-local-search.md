# 本地 GeoNames 数据库

本工程使用独立 Docker Compose 项目部署 PostgreSQL/PostGIS，通过 Go 命令导入本地 GeoNames 快照。命令行和 HTTP 查询复用同一名称检索逻辑，前端“查询索引 → 地名查询”已接入真实候选与地图定位。

## 数据库与目录

| 项目 | 配置 |
| --- | --- |
| Compose 项目 | `digitalearth-geonames` |
| 数据库服务 | `db`，容器 `digitalearth-geonames-db-1` |
| 数据库名及本地开发用户 | `digitalearth` |
| 宿主机地址 | `127.0.0.1:55432` |
| Docker 网络内地址 | `db:5432` |
| 数据持久卷 | `digitalearth-geonames_postgres-data` |
| 地名 Schema | `gazetteer` |
| 原件目录 | 仓库外 `../data/geonames/20261021`，只读挂载为 `/data` |
| 报告目录 | 仓库外 `../work/geonames`，挂载为 `/reports` |
| 本地密码 | `infra/db-password.local`，已被 Git 忽略，初始化脚本生成且不打印 |
| API 服务 | `api`，容器 `digitalearth-geonames-api-1`，`127.0.0.1:8080` |
| API 数据库用户 | `digitalearth_reader`，只读地名表 |
| API 密码 | `infra/api-password.local`，独立生成并被 Git 忽略 |

PostGIS 镜像沿用同伴文档的 `17-3.6-alpine` 系列，并固定实际镜像摘要。2026-11-04 实测为 PostgreSQL 17.11、PostGIS 3.6.4。Go 在构建容器中运行，本机无需安装 Go。依赖通过 `go.mod`、`go.sum` 固定，构建镜像同样固定摘要。

数据库、网络、卷均属于本工程，未接入或修改同组服务器。宿主机端口只绑定回环地址。`digitalearth` 是导入及管理用户；API 使用 `digitalearth_reader`，只授予地名 Schema 使用和三表 SELECT，设置默认只读事务，不挂载管理员密码、原始数据或报告目录。

## 初始化与运行

以下命令从仓库根目录执行，需要 Docker Desktop 的 Linux 引擎运行。PowerShell 脚本只准备本地密码与报告目录，不会重置已有密码。

```powershell
.\infra\Initialize-LocalDatabase.ps1
docker compose up -d --wait db
docker compose build gazetteer
docker compose run --rm gazetteer import --report /reports/import.json
docker compose run --rm gazetteer verify --report /reports/verification.json
docker compose run --rm gazetteer query --q "北京" --limit 6
docker compose run --rm gazetteer setup-reader
docker compose up -d --wait api
```

`gazetteer` 是 `operations` profile 下的一次性任务，执行后删除任务容器，数据库继续运行。`--report` 路径位于容器内，报告需写到 `/reports/`。省略时仅输出 JSON。修改导入或查询源码后重新执行构建命令。

`setup-reader` 是显式管理操作，用当前 API 密码文件配置只读账号，不修改地名记录。第一次接入 API 时执行；日常启动无需再次执行，也无需重新导入。修改 API 密码文件后需要重新执行该命令并重建 API 容器。修改代码后执行 `docker compose build gazetteer` 和 `docker compose up -d --wait api`。

端口可用根目录被忽略的 `.env` 中的 `DIGITALEARTH_DB_PORT` 调整，默认 55432。数据与报告目录可通过 `GEONAMES_DATA_DIR`、`GEONAMES_REPORT_DIR` 覆盖；相对路径以 Compose 文件所在目录为基准。输入目录不存在时直接报错，不创建空数据目录。

API 宿主机端口可通过 `DIGITALEARTH_API_PORT` 调整，默认 8080。若更改，启动前端时同步设置进程环境变量 `DIGITALEARTH_API_TARGET=http://127.0.0.1:新端口`，然后重启开发或预览服务；默认不需要设置。

## 平台地名查询

日常先运行 `docker compose up -d --wait db api`，再按 README 启动前端。5173 开发服务和 4173 生产预览使用 `/api` 同源代理。静态生产托管需单独配置 `/api` 到 Go 服务的反向代理。

| 请求 | 含义 |
| --- | --- |
| `GET /api/v1/locations?q=江西&limit=6` | 返回真实候选数组及 GeoNames 署名 |
| `GET /healthz` | 检查数据库及有效非空快照，供容器健康检查使用 |

查询成功返回 HTTP 200，即使无匹配也返回 `results: []`。非法输入返回 400，其他请求方法返回 405，数据库不可用返回 503，查询超时返回 504；响应不包含数据库错误细节或凭据。未建设登录系统，当前用于仅绑定本机的学习与试验环境。

前端输入后防抖 300 ms，搜索按钮或回车可立即查询；支持上下键与回车选择，旧请求会取消。候选第二行显示归属：居民点为“标准名称 · 一级行政区 · 国家”，一级行政区为“标准名称 · 国家”，国家仅显示标准名称。空缺层级直接省略，国家、行政区名称多为源英文值；没有补造市县层级。

选择后显示名称标记和地点属性，国家及一级行政区明确提示近似代表点。默认相机高度为国家 6,000 km、一级行政区 1,200 km、居民点 120 km，属于可调整的观察高度，不代表行政边界范围。地形高度异步更新并保留地名属性。查询无结果和服务失败分别提示，失败时可重试，已有场景与选中地点仍保留。

查看数据库或手工执行 SQL：

```powershell
docker compose ps
docker compose exec db psql -U digitalearth -d digitalearth
```

若用数据库客户端连接，填写上述宿主机地址、数据库名和用户，密码从本机密码文件读取。不要将密码粘贴到聊天、源码或连接示例中。

停止和重新启动：

```powershell
docker compose stop db
docker compose up -d --wait db
```

普通停止、重启及不带卷删除选项的 `docker compose down` 保留数据。不要删除数据卷；数据卷不是备份。首次初始化后，修改密码文件不会自动更改数据库内密码。

## 沿用的处理方法

依据本地《全球数据下载任务量估算》地名章节重建以下流程；此次未取得同伴原始实现源码，不能认定名称列表及内部排序常量逐项相同。

1. 校验并读取四个原件：`cities500.zip`、`alternatenames/CN.zip`、`admin1CodesASCII.txt`、`countryInfo.txt`，记录各文件 SHA-256。ZIP 内文本直接读取，不先解压。
2. 从 `cities500` 保留居民点类 `P` 中人口至少 500 的记录，或 `PPLC/PPLA/PPLA2/PPLA3/PPLA4` 行政驻地。检查 ID、UTF-8、列数、经纬度、人口和日期；异常返回文件与行号，不静默忽略损坏记录。
3. 关联国家及一级行政区。以保留城市点计算国家、一级行政区的球面加权代表点；无保留城市的地区不生成代表点。行政归属无法关联时保留原始代码并计数，不伪造名称。
4. 城市名称及别名来自 `cities500`。`CN.zip` 仅补充已保留国家、一级行政区的名称，不用于补充城市或生成缺失地点。排除 `link/wkdt/post` 记录，统计未匹配和非名称记录。
5. 检索名称采用 Unicode NFKD、小写化、去组合附加符，非字母数字字符转为空格并合并连续空格，保留中文。以地点 ID 和规范化名称去重，优先保留汉字名称，每地点最多 32 个名称。
6. PostgreSQL COPY 写入两张事务临时表，检查名称引用；在同一事务中替换 `gazetteer` 地名数据和有效快照。失败回滚，不涉及其他业务 Schema。拒绝用空数据集替换快照。

原件、地点及名称在解析整理期间会占用内存；ZIP 按流读取不代表全流程恒定内存。

### 本地实现明确的细节

同伴文档未给出全部算法常量，本工程使用以下固定规则并由测试覆盖：

- 代表点权重为 `max(population, 1)`。经纬度转换为单位球三维向量，加权累加后转换回经纬度，避免在日期变更线附近直接平均经度。国家及一级行政区结果明确标记 `approximate_representative_point=true`，不是官方行政区几何中心。
- 名称基础优先级为标准名称 10、ASCII 名称 20、别名 30；汉字名称减 10。CN 首选名称使用 10，历史名称再加 10。相同规范化键保留较低优先级，平局按原名称排序；截取 32 个名称时先保留含汉字名称，再按优先级和规范化键排序。
- 地点重要度为国家 0、一级行政区 5、首都 10、一级行政驻地 15、二级行政驻地 20、三级及四级行政驻地 25、其他居民点 30，数值越小越优先。
- 总输入摘要为固定顺序下各项 `相对路径 + NUL + 文件 SHA-256 + 换行` 的 SHA-256。四个文件的摘要可与同伴原件直接比较；总摘要因拼接规则未在同伴文档定义，不直接比较。

## 表与查询

持久化地名表仅三张，DDL 位于 `backend/internal/gazetteer/schema.sql`：

- `gazetteer.places`：地点编号、类型、名称、国家/一级行政归属、分类、WGS84 经度/纬度、人口、重要度及源修改日期。国家与一级行政区的人口是保留地点人口之和，仅用于排序，可能包含重叠统计，不能作为实际人口。
- `gazetteer.names`：地点外键、显示名称、规范化名称和优先级；主键为 `(place_id, normalized_name)`，前缀索引为 `(normalized_name text_pattern_ops, priority, place_id) INCLUDE (name)`。
- `gazetteer.snapshot`：唯一有效快照、输入摘要、导入时间、数量、来源、许可及署名。

这三张表沿用经纬度数值列，不含 `geometry` 或空间索引。国家、一级行政区字典在导入时关联，相关属性写入地点表，不另建持久字典表。高程、DEM 不进入本轮查询表，避免误作 Cesium 椭球高。

输入与导入共用规范化函数。支持精确及前缀匹配，每地点合并为一个候选，按匹配质量、名称优先级、地点重要度、人口、ID 排序。规范化输入长度为 2–100 个字符，默认返回 6 条、最多 10 条。查询使用参数绑定，截止时间 750 ms；这不是实测性能保证。暂无拼写纠错、任意子串搜索、地址解析或自动数据更新。

GeoNames 来源及许可在命令输出、快照和本说明中保留：[GeoNames](https://www.geonames.org/)，[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，[数据格式说明](https://download.geonames.org/export/dump/readme.txt)。

## 验证

镜像构建执行 Go 单元测试，覆盖名称规范化、跨日期变更线代表点、低人口行政驻地保留、普通低人口点过滤、中文别名范围、名称去重与上限、空字段和损坏行。

`verify` 检查实际数量与快照一致、三张地名表、外键关联、坐标范围、每地点名称数量，以及：

- 北京 / Beijing 指向相同的城市 ID，同时区分一级行政区候选。
- 巴黎 / Paris 返回法国城市；Paris 同时保留其他国家的同名地点。
- 禄口、中国、江苏可查，国家和一级行政区结果标注近似代表点。
- New Yo 前缀检索、São Paulo / Sao Paulo 重音规范化。
- 无结果查询、过短或过长输入、非法结果上限。
- 完整检索 SQL 的 `EXPLAIN (ANALYZE, BUFFERS)` 使用名称前缀索引。

数据库事务回滚集成测试位于 `TestImportFailureRollsBack`，默认跳过。仅在本工程已导入的开发库上，通过构建阶段镜像并设置 `GAZETTEER_INTEGRATION=1` 显式执行。测试在事务内尝试导入重复名称，使正式表插入失败，验证旧快照、数量和查询均保持可用。

本次实测数量、耗时、查询结果和与同伴记录的差异见 `docs/geonames-validation.md`。
