# DigitalEarth

基于 CesiumJS 的数字地球仿真展示工程，提供地球浏览、图层管理和查询索引，逐步接入多目标轨迹姿态回放及外部成果展示。

## 环境要求

- Node.js 22 或更高版本
- npm
- 支持 WebGL 的现代浏览器

## 安装与运行

在代码仓库根目录打开终端：

```bash
cd frontend
npm ci
npm run dev
```

开发地址为 `http://127.0.0.1:5173/`。按 Ctrl+C 停止服务。端口被占用时会明确报错，不自动更换端口。

PowerShell 如果限制执行 `npm.ps1`，将命令中的 `npm` 换成 `npm.cmd` 即可。

## 配置 Cesium ion 影像与地形

在 `frontend` 目录将 `.env.example` 复制为 `.env.local`，填入具有全球影像（资产 2）和全球地形（资产 1）读取权限的 Cesium ion Token：

```dotenv
VITE_CESIUM_ION_TOKEN=你的Token
```

已有 `.env.local` 时直接编辑，不必覆盖。修改后重启开发服务；生产环境需重新构建。

应用通过 `createWorldImageryAsync({ style: IonWorldImageryStyle.AERIAL })` 加载 Cesium World Imagery，作为默认全球影像底图。未配置 Token、权限不足或网络连接失败时显示错误，可在修正后点击“重新加载”。不再加载 Natural Earth II，也不自动切换其他底图。

地形独立通过 `createWorldTerrainAsync()` 加载 Cesium World Terrain，图层管理面板提供关闭和重试操作。未配置 Token 时使用 WGS84 椭球面；地形服务连接或瓦片加载失败时回退到椭球面，不影响已加载的全球影像。

`.env.local` 已由 Git 忽略。`VITE_*` 配置会进入浏览器代码，请使用适合浏览器端的专用只读 Token，并按需限制可访问资源和来源 URL；不要填入账户管理或其他服务的私密凭据。

## 构建与预览

以下命令在 `frontend` 目录执行：

```bash
npm run typecheck
npm run build
npm run preview
```

生产输出位于 `frontend/dist/`，预览地址为 `http://127.0.0.1:4173/`。通过 HTTP 服务运行页面，保留 `cesium/` 静态资源目录及相对引用。Cesium 引擎分块较大，构建可能出现包体积提示。

## 当前功能

- 图层管理：Cesium ion 全球卫星影像、真实地形状态、中国省级行政区界线 WMS 叠加及网格辅助线。
- 查询索引：真实 GeoNames 地名搜索、归属层级候选、键盘选择、地图定位，以及独立的坐标定位页签。
- 地图工具：默认地名注记、点标注、两点直线及多点折线测量，标注和测量成果保存到 PostgreSQL/PostGIS。
- 卫星轨迹：后端读取 CelesTrak 公开 GP 要素，通过 C++ SGP4 DLL 生成国际空间站、哈勃和 NOAA-20 的轨迹，支持统一时钟回放、结果保存和复用。
- 地球浏览：缩放、旋转、倾斜、指北、初始视角、全球视角与二维/三维切换。
- 地表坐标拾取、选中属性与相机高度显示。
- 深蓝色工作台、白色文字和图标，以及蓝色背景的选中状态。

全球影像与真实地形是独立资源。影像显示地表纹理，地形提供高程起伏，两者需要分别具备访问权限。

## 中国省界地图服务

前端通过 Cesium `WebMapServiceImageryProvider` 读取已发布的 `China:中国省级行政区`，默认开启，使用独立的 `China:province_outline_dynamic` 可调样式（透明填充、省界描边）叠加在卫星影像上。原 GeoServer 默认样式保持不变。进入“图层管理 → 行政区划”可以开关图层、定位到中国，以及在加载失败后重试。省界服务失败会单独显示提示。

点击该图层的“图层属性”，可调整不透明度（0–100%）、线色和线宽（0.5、1、1.5、2、3、4、6 px），查看资源信息或恢复默认设置。颜色支持系统取色器和 `#RRGGBB` 输入。不透明度由 Cesium 即时调整；颜色和宽度通过 WMS `env` 参数由 GeoServer 重新渲染，连续修改会合并请求。加载新样式前保留上次有效图层；失败后可重试。

显示开关和三个样式属性自动保存在当前浏览器、当前网站来源的 `localStorage` 中，刷新后恢复。存储键按服务地址和图层名称区分；更换浏览器、域名或端口时不会自动同步。存储受限时仍可调整，并会显示未保存提示。当前只有一个业务图层，上移和下移按钮禁用，卫星底图固定在底部。

本地试验需要先启动 Docker Desktop 中的 `geoserver-lab / geoserver-local`，等待健康状态正常，再运行前端。GeoServer 地址为 `http://127.0.0.1:8081/geoserver/`，本地现有数据卷和发布配置由独立的 GeoServer 实验目录管理，本仓库不包含 Shapefile 或服务端管理凭据。

开发服务和生产构建预览均将相对路径 `/geoserver` 代理到 `http://127.0.0.1:8081`。请求采用 WMS 1.1.1、EPSG:4326、透明 PNG，由 GeoServer 将原始 EPSG:4490 数据投影后输出。前端只接收地图图片；省份属性查询尚未接入。

可以在 `frontend/.env.local` 中增加以下配置，已有 Cesium Token 无需更改：

```dotenv
VITE_PROVINCE_WMS_URL=/geoserver/China/wms
VITE_PROVINCE_WMS_LAYER=China:中国省级行政区
VITE_PROVINCE_WMS_STYLE=China:province_outline_dynamic
DIGITALEARTH_GEOSERVER_TARGET=http://127.0.0.1:8081
```

图层名区分大小写。修改配置后重启 Vite；生产部署时，`VITE_*` 变更需要重新构建。将来迁移到 GIS 服务器，可以保留相对 URL，修改代理目标。正式静态部署需要在网站服务器配置 `/geoserver` 反向代理，Vite 的代理配置不会随 `dist` 自动部署；也可改用允许该前端来源跨域访问的完整 WMS 地址。

首次部署可调样式时，在仓库根目录使用 PowerShell 7 执行下列命令，交互输入 GeoServer 管理凭据。脚本发布 [SLD 样式](infra/geoserver/province_outline_dynamic.sld)，将其登记为省界的可选样式，保留原默认样式；再次执行会更新这个专用可调样式。管理凭据仅用于发布，不进入前端配置。当前本机实验服务已完成此步骤。

```powershell
.\infra\geoserver\Publish-ProvinceStyle.ps1 -Credential (Get-Credential)
```

迁移时可用 `-GeoServerUrl https://服务器地址/geoserver` 指定目标，并先准备同名工作区和图层。前端设置校验、持久化及存储异常测试可在 `frontend` 运行 `npm run test`。

## 本地地名数据库

已提供独立 Docker Compose PostgreSQL/PostGIS 数据库、Go 导入程序、HTTP 查询服务和前端地名查询。数据库默认仅监听 `127.0.0.1:55432`，API 仅监听 `127.0.0.1:8080`，地名数据保存在独立持久卷中。API 使用独立只读账号。

在仓库根目录运行以下 PowerShell 命令，需要 Docker Desktop 的 Linux 引擎：

```powershell
.\infra\Initialize-LocalDatabase.ps1
docker compose up -d --wait db
docker compose build gazetteer
docker compose run --rm gazetteer import --report /reports/import.json
docker compose run --rm gazetteer setup-reader
docker compose up -d --wait api
docker compose run --rm gazetteer query --q "北京" --limit 6
docker compose run --rm gazetteer verify --report /reports/verification.json
```

默认读取仓库外 `../data/geonames/20261021` 已有四个文件，原件只读挂载。配置、导入规则、数据边界及维护方式见 [本地地名数据库说明](docs/geonames-local-search.md)，实际验证结果见 [GeoNames 验证记录](docs/geonames-validation.md)。

已初始化并导入后，日常只需 `docker compose up -d --wait db api`，再启动前端开发服务。进入“查询索引 → 地名查询”输入地名；候选第二行显示标准名称、一级行政区和国家，点击后定位。输入至少两个有效字符，支持精确与前缀匹配。前端开发和生产预览均通过相对路径 `/api` 转发到本机 API。

## 地图标注与距离测量

左侧笔图标用于新建标注，可用地图点选、经纬度或地名查询结果。尺图标提供直线和折线。直线取两点，折线逐点追加并点击“完成测量”，两种方式均可预览后保存。已保存标注可作为测量起点。地名注记默认开启，可在图层管理中切换；可见的城市点可吸附，海域文字用于地图参考。

测量按 WGS84 椭球的最短测地线逐段计算，地形仅用于地图绘制。数据库保存有序顶点、点名和坐标快照、未舍入的分段和总米数。标注修改后仍可复现原测量。应用打开时从成果库读取已保存记录，绘制草稿保留在当前页面。

本机首次初始化或更新部署时，在仓库根目录运行：

```powershell
.\infra\Initialize-LocalDatabase.ps1
docker compose up -d --wait db
docker compose build workspace-setup
docker compose run --rm --no-deps workspace-setup
docker compose up -d --no-deps --wait api
```

成果库 `digitalearth_workspace` 和 GeoNames 库共用 PostgreSQL 容器。初始化单独启用 PostGIS、应用迁移并配置成果读写角色。Go API 通过 `/api/v1/map-workspace` 提供本机默认工作区的成果读写；GeoNames 查询继续使用只读账号。备份和恢复用户成果以 `digitalearth_workspace` 为单位。

## 公开卫星轨迹

卫星模块已接入主项目左侧“卫星轨迹”，与图层、查询功能共用同一个 Cesium Viewer。前端只选择卫星和控制回放，不录入轨道参数。使用 CelesTrak 公开 GP 要素，由后端 SGP4 推算位置；不是实时遥测。

启动 Docker Desktop 后，在仓库根目录打开一个 PowerShell 终端：

```powershell
.\infra\Start-Satellites.ps1
```

另一个终端按前面的方式在 `frontend` 运行 `npm.cmd run dev`，访问 `http://127.0.0.1:5173/`，进入“卫星轨迹”加载。卫星 API 为 `127.0.0.1:8093`，Vite 开发/预览将 `/api/v1/satellites` 单独代理至该服务，其他 `/api` 继续访问 Go 地名服务。既有 GeoNames 和省界服务按原方式启动。

完整时序数据保存在 MinIO，PostgreSQL 保存要素快照、任务与成果索引。相同要素版本、时段和算法复用结果；倍速、暂停和拖动时间轴只在浏览器运行。数据来源、要素历元和获取时间均可在面板查看。初始化可复用原本机持久卷和凭据，不会删除原有数据。

环境、来源、时效、坐标近似和源码入口见 [卫星轨迹接入说明](docs/satellites.md)。

## 技术说明

前端采用 React 19、TypeScript 5、Vite 6 和原生 CesiumJS 1.146.0，依赖版本由锁文件固定。一个工作区保持一个 Viewer，界面通过场景控制器调用 Cesium，面板切换保留场景。

坐标为 WGS84 十进制度，经度在前、纬度在后；高度采用椭球高，单位为米。椭球面模式的地表高度为零；真实地形拾取使用当前加载的地形网格，精度受数据与细节层次影响。坐标定位在真实地形模式下异步采样高度，尚未取得高度时显示“待加载”。

地名数据准备和查询采用 Go 与 PostgreSQL/PostGIS，前端通过 HTTP 接口读取候选。当前归属信息包含国家和一级行政区，不代表完整的全球市县行政区划。轨迹、姿态、引力场及落点成果由上游提供，本工程负责接入、管理和展示。

## 参考与署名

- [CesiumJS 官方文档](https://cesium.com/learn/cesiumjs-learn/)
- [Cesium ion Access Tokens](https://ion.cesium.com/tokens)
- [Vite 环境变量说明](https://vite.dev/guide/env-and-mode)
- [Cesium WMS 图层接口](https://cesium.com/learn/cesiumjs/ref-doc/WebMapServiceImageryProvider.html)

全球影像及地形通过 Cesium ion 访问。运行界面保留 Cesium 及资源提供方署名，许可与第三方说明随静态资源发布。
