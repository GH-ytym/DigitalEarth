# 公开卫星轨迹

主项目使用真实发布的 CelesTrak GP 轨道要素，在后端通过 C++ SGP4 DLL 生成轨迹，前端只选择卫星、读取成果和控制回放。卫星、地名查询、省界及地图浏览共用现有 Cesium Viewer。轨迹位置是模型推算结果，不是实时遥测。

## 数据来源与时间

默认目录为国际空间站 ISS（25544）、哈勃 HST（20580）和 NOAA-20（43013）。后端按 NORAD 编号读取 CelesTrak CSV，字段采用其 OMM 命名，包括历元、平均运动、偏心率、倾角、升交点赤经、近地点幅角、平近点角、BSTAR 等。种子文件 `services/satellites/data/public-gp.csv` 保存公开源的实际响应字段，配套 JSON 记录来源 URL 和获取时间。

每个卫星的要素历元与数据获取时间分别保存，不能混为一谈。目录请求按需检查更新，手动“更新数据”也使用同一套两小时最小间隔；状态写入 PostgreSQL，重启不重置间隔。请求 gzip 压缩，不在浏览器反复下载公开源。源返回错误时立即停止本轮后续请求，保留上次完整快照并显示更新失败，不虚构新数据。

回放默认使用当前 UTC 两小时时段，步长 10 秒。重复请求同一时段、同一要素和同一算法会命中已保存成果。要素超过六天时使用其历元附近的历史时段并明确标记；更新后仍可加载旧成果，每份成果保留它当时使用的完整要素和来源。

参考：[CelesTrak GP 格式](https://celestrak.org/NORAD/documentation/gp-data-formats.php)、[使用政策](https://celestrak.org/usage-policy.php)。

## 运行

需要 Docker Desktop Linux 引擎、uv、Windows x64 Python 和已安装的前端依赖。在仓库根目录运行：

```powershell
.\infra\Start-Satellites.ps1
```

脚本同步 `services/satellites/uv.lock`，准备本机私密配置和持久卷，在必要时编译 DLL，启动本项目的卫星存储容器，并以前台运行 FastAPI。编译器由项目开发依赖 `ziglang` 提供，首次下载后无需单独安装 Visual Studio。手动编译：在 `services/satellites` 执行 `uv run python build_native.py`，编译前先停止当前 API。

另一个终端进入 `frontend` 执行 `npm.cmd run dev`，访问主项目的 `http://127.0.0.1:5173/`，进入“卫星轨迹”。也可用 `/?panel=satellites` 直接打开该面板。没有新的独立前端页面，FastAPI 只提供 API。

| 组件 | 本机地址或文件 |
| --- | --- |
| 主前端 | `127.0.0.1:5173`，生产预览 `4173` |
| 卫星 API | `127.0.0.1:8093/api/v1/satellites` |
| PostgreSQL | `127.0.0.1:55433` |
| MinIO S3 / 管理界面 | `127.0.0.1:19000` / `19001` |
| 服务配置 | `services/satellites/.env`，不提交 |
| DLL | `services/satellites/build/satellites.dll`，不提交 |
| SGP4 源码 | `services/satellites/native/`，含固定版本上游代码和归属说明 |

本机初始化可以保留原卫星实例的凭据与命名卷，原教学成果表及对象不删除，新模块使用自己的 `satellite_results` 表和 `satellite-results` 桶。全新环境生成新的本机密码与命名卷。不要删除卷来修复普通启动问题，也不要覆盖已有 `.env`。

Ctrl+C 停止 API；在仓库根目录执行下列命令停止卫星存储，保留数据：

```powershell
docker compose --env-file services/satellites/.env -f infra/satellites.compose.yaml stop
```

仅运行单个 API 进程。正常轨迹计算由受限线程执行，最多一个运行、两个等待，不引入 MQ、定时任务或独立调度服务。服务重启把未完成任务标为失败，可以重新加载触发重试，已成功成果不受影响。

## 数据传输

```text
后端读取或更新公开 CSV 要素
    → PostgreSQL 保存完整要素快照及来源
前端 POST { norad_ids: [...] }
    → 后端按要素指纹、时段、DLL 和协议版本查找成果
    → 未命中：Python ctypes 调 C++ SGP4
    → C++ 写出 [dt_s, x_m, y_m, z_m] 数组
    → MinIO 保存完整采样，PostgreSQL 登记摘要和对象键
前端获取成果说明与采样地址
    → 下载完整 JSON
    → Cesium 时序位置属性 + 全局时钟驱动模型、尾迹和参数
```

| API 路径，相对于 `/api/v1/satellites` | 用途 |
| --- | --- |
| `GET /catalog` | 获取公开目录、来源及要素历元，按需检查更新 |
| `POST /refresh` | 按同一最小间隔更新公开数据 |
| `POST /tracks` | 仅接收卫星编号；返回任务或复用成果 |
| `GET /jobs/{id}` | 查询真实任务状态 |
| `GET /tracks` | 已保存成果列表 |
| `GET /tracks/{id}` | 成果说明，含时段、坐标、单位、要素、来源和采样地址 |
| `GET /tracks/{id}/samples` | 从 MinIO 流式下载完整采样 |
| `GET /health` | 数据库、对象桶及本进程 DLL 调用情况 |

`POST /tracks` 不接受高度、倾角或其他用户自定义轨道参数。要素来自后端公开目录，时段和采样由服务器确定。新任务返回 202，已有成功成果返回 200 和 `cache_hit=true`。同一条件正在执行则共用任务，不重复传播。

结果键包含卫星编号、要素指纹、回放时段、输出步长、DLL 内容指纹和坐标/数据格式版本。只改变颜色、视角、暂停、倍速或滑块位置不调用后端。更新要素或算法产生新成果，旧结果继续按原始版本解释。

## 传播与坐标约定

SGP4 使用 Vallado C++ 实现，WGS72 常量、improved 模式。该实现按 GP 的平均要素进行传播，不能把 GP 字段当成普通二体轨道的瞬时根数。上游文件固定在 CelesTrak 仓库提交 `faa0d45f504e51f9d0b946594c39f18b311ab992`，原始 `NOTICE` 和来源保存在 `native/vendor/`。

SGP4 输出 TEME 位置（km）。本模块按每个采样时刻的 GMST 旋转为近似地固坐标，并转换为米，UT1 近似取 UTC、极移取零；结果标记 `ECEF_APPROX`。这适合当前可视化，不宣称经过完整 EOP 修正的精密 ITRF 解算。将来增加 EOP、速度或真实姿态时，需要更新转换与成果版本。

Python 为输出数组分配内存，DLL 接收数值数组和输出指针，写出行数并返回错误码。C++ 异常在导出边界捕获；内部 `elsetrec`、类和 STL 不穿过 ABI。DLL 不知道 HTTP 和前端，也不访问 MinIO 或数据库。

GLB 是原创示意模型，在远距离放大以便辨认；轨道位置使用实际米制坐标。模型按速度方向摆放，不代表真实卫星姿态。空间轨迹不贴地，地固视角下的曲线也不必闭合为同一平面椭圆。

参考：[SGP4 原始说明与坐标输出](https://celestrak.org/publications/AIAA/2006-6753/faq.php)。

## 主前端接入与生命周期

`SatellitePanel.tsx` 只提供真实卫星选择、更新数据、历史成果及来源查看。`api.ts` 校验编号、格式、单位、时间和完整采样数组。通过验证后，`SceneController.loadSatellites` 把数据交给 `SatellitePlayback`。

`SatellitePlayback` 通过 `CustomDataSource` 管理自己的对象集合，使用现有 Viewer，不删除其他图层、地名标记和鼠标监听。切换面板保留场景和当前时间，卸载轨迹只清除卫星对象。控制器销毁时移除卫星时钟监听并销毁数据源。

采样通过 `SampledPositionProperty(ReferenceFrame.FIXED)` 建立时间与空间位置的关系，使用线性插值。所有卫星共用时钟。播放时允许时间变化触发渲染，暂停后恢复按需渲染；参数读数节流更新。单次采样是每 10 秒，屏幕帧率和 60 倍速是显示设置，不改变传播结果。

右下角“时间轴与曲线”默认折叠，加载轨迹后可展开播放、倍速、跟随和拖动控件；收起不暂停回放、不卸载轨迹。卫星跟随从卫星上方约 16000 km 俯视，保持地球远景与北向朝上，只让视野中心随卫星移动；使用固定 ENU 跟踪参考系，仍可手动缩放，播放和拖动时间保留调整后的视距。每颗卫星以同一回放时刻的位置沿 WGS84 椭球法线计算星下点，仅显示当前点及名称，不绘制地面轨迹；启用地形时将标记贴地显示。星下点由前端已有位置计算，不增加后端请求或成果副本。来源与获取时间保留在可展开的来源信息中，算法细节见本文。

Vite 开发和预览把更具体的 `/api/v1/satellites` 路由放在通用 `/api` 前面，因此不影响原 Go 地名服务。正式静态部署也要在网站服务器设置等价反向代理；Vite 配置不会随 `dist` 自动部署。卫星 API 的目标可通过 `DIGITALEARTH_SATELLITES_TARGET` 配置。

## 代码阅读与验证

按以下顺序阅读即可跟踪一条完整链路：

1. `frontend/src/features/satellites/SatellitePanel.tsx`、`api.ts`：卫星编号请求、任务查询、成果下载。
2. `services/satellites/catalog.py`：公开源读取、快照、限频和失败保留。
3. `app.py`、`service.py`：路由、结果键、任务和成果组织。
4. `dll_adapter.py`、`native/orbit.cpp`：GP 字段转换、内存、SGP4 与 TEME 转换。
5. `storage.py`：索引和完整采样分开保存。
6. `frontend/src/features/satellites/SatellitePlayback.ts`：同一 Viewer 中的数据源、时钟和渲染。

前端在 `frontend` 执行 `npm.cmd run test`、`npm.cmd run build`。卫星后端保持存储容器运行、停止 API，然后在服务目录执行：

```powershell
uv run python -m unittest discover -s tests -p test_satellites.py -v
```

测试将三份实际公开 GP 数据的 DLL 输出与 Python SGP4 参考实现比较，并验证缓冲区边界、保存、复用及应用重建。SGP4 包仅用于开发测试，不参与生产传播。

主前端和 API 启动后，在服务目录执行 `uv run python tests/browser_main.py`，验证单 Viewer、动态运行、时间轴展开与折叠、跟随视角、暂停/倍速/拖动无 API 调用、历史恢复，以及原图层和查询面板。前端单元测试验证星下点的椭球投影、插值时刻和时间范围。截图和临时运行结果位于仓库 `work/satellites`，不进入提交。
