# DigitalEarth

数字地球仿真展示学习与试验工程，服务于太空垃圾或碎片飞行系统的三维展示部分。当前从基础地球场景开始，后续建设真实地名查询、多目标轨迹姿态回放和外部成果展示。

## 当前功能

- 本地加载 Cesium 随附的 Natural Earth II 低分辨率底图，无需 Cesium ion Token。
- 地球缩放、旋转、倾斜、初始视角、全球视角、指北复位及二维/三维切换。
- 图层面板、底图切换、网格辅助线与昼夜光照开关。
- 鼠标地表坐标、单击拾取标记、属性显示与清除。
- WGS84 十进制度坐标定位及输入校验。
- 顶部栏、左侧导航、浮动面板、右侧地图控制和底部状态栏。

当前地形为 **WGS84 椭球面**，拾取高度为椭球高。Natural Earth II 仅用于全球浏览，不是高分辨率卫星影像；尚未接入真实高程地形或地名查询服务。

## 本地运行

环境要求：Node.js 22 或更高版本、npm、支持 WebGL 的现代浏览器。首次安装依赖需要网络，安装后场景使用本地静态资源。

```powershell
cd F:\cjy\Code\DigitalEarth\frontend
npm ci
npm run dev
```

打开终端显示的地址，默认为 `http://127.0.0.1:5173/`。终端按 Ctrl+C 停止。端口被占用时会明确报错，不自动改用其他端口。

PowerShell 若限制运行 `npm.ps1`，可使用 `npm.cmd ci` 和 `npm.cmd run dev`，无需修改系统执行策略。

```powershell
# 类型检查与生产构建
npm run build

# 检查打包后的本地页面
npm run preview
```

生产构建位于 `frontend/dist/`，预览默认地址为 `http://127.0.0.1:4173/`。应通过 HTTP 服务运行，不能直接双击 `dist/index.html`。Cesium 引擎包较大，首次打包会提示分块体积；当前按一个独立引擎包处理。

## 工程结构

```text
frontend/
  public/                   网站图标
  src/
    components/             界面通用组件
    config/scene.ts         初始视角与资源路径
    features/globe/         Cesium 场景与生命周期
    features/locations/     坐标定位及后续地名查询入口
    App.tsx                 工作台布局与可序列化界面状态
    main.tsx                设置 Cesium 资源路径
    bootstrap.tsx           React 启动入口
    styles.css              工作台样式与响应布局
  vite.config.ts            构建及 Cesium 静态资源发布
docs/
  development.md            架构说明、学习入口与阶段验收
```

本地已有 `文档资料/`、`文献/`、`data/`、`work/` 保持原位，通过 `.gitignore` 排除，不随源码提交。新增数据、凭据和临时输出也应遵循该规则。

## 技术基线与边界

前端使用 React 19、TypeScript 5、Vite 6 和原生 CesiumJS 1.146.0，具体版本固定在 `package.json` 与 `package-lock.json`。界面操作通过场景控制器驱动一个 Viewer；面板切换不重新创建场景。当前 React 本地状态已经足够，暂不引入共享状态库。

后续后端采用 Go，地名索引采用独立的 PostgreSQL/PostGIS。GeoServer/GWC、MinIO 和 ECharts 随需求阶段接入。本项目不引入实时协同、独立消息队列或分布式任务平台。

轨迹、姿态、引力场和落点成果由上游提供，本工程负责接入、管理与展示；模型文件加载成功不代表已实现对应计算算法。

## 参考与署名

- [CesiumJS 官方快速入门](https://cesium.com/learn/cesiumjs-learn/cesiumjs-quickstart/)
- [CesiumJS API](https://cesium.com/learn/cesiumjs/ref-doc/)
- 底图使用 Cesium npm 包自带的 Natural Earth II 数据；运行界面保留 Cesium 署名。依赖的许可与署名随 Cesium 静态资源一同发布。
