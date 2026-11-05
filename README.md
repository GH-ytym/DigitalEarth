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

- 图层管理：Cesium ion 全球卫星影像、真实地形状态及网格辅助线。
- 查询索引：真实 GeoNames 地名搜索、归属层级候选、键盘选择、地图定位，以及独立的坐标定位页签。
- 地球浏览：缩放、旋转、倾斜、指北、初始视角、全球视角与二维/三维切换。
- 地表坐标拾取、选中属性与相机高度显示。
- 深蓝色工作台、白色文字和图标，以及蓝色背景的选中状态。

全球影像与真实地形是独立资源。影像显示地表纹理，地形提供高程起伏，两者需要分别具备访问权限。

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

## 技术说明

前端采用 React 19、TypeScript 5、Vite 6 和原生 CesiumJS 1.146.0，依赖版本由锁文件固定。一个工作区保持一个 Viewer，界面通过场景控制器调用 Cesium，面板切换保留场景。

坐标为 WGS84 十进制度，经度在前、纬度在后；高度采用椭球高，单位为米。椭球面模式的地表高度为零；真实地形拾取使用当前加载的地形网格，精度受数据与细节层次影响。坐标定位在真实地形模式下异步采样高度，尚未取得高度时显示“待加载”。

地名数据准备和查询采用 Go 与 PostgreSQL/PostGIS，前端通过 HTTP 接口读取候选。当前归属信息包含国家和一级行政区，不代表完整的全球市县行政区划。轨迹、姿态、引力场及落点成果由上游提供，本工程负责接入、管理和展示。

## 参考与署名

- [CesiumJS 官方文档](https://cesium.com/learn/cesiumjs-learn/)
- [Cesium ion Access Tokens](https://ion.cesium.com/tokens)
- [Vite 环境变量说明](https://vite.dev/guide/env-and-mode)

全球影像及地形通过 Cesium ion 访问。运行界面保留 Cesium 及资源提供方署名，许可与第三方说明随静态资源发布。
