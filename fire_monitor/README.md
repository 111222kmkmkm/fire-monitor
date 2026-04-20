# fire_monitor

Vue 3 + OpenLayers + MapTiler Weather 的火情环境监测示例。

## 当前状态

- 已移除实时火点获取与展示功能（Himawari / VIIRS）
- 保留 Windy 环境场同步能力
- 保留 OpenLayers 底图与辅助图层（城市边界、消防站）
- 保留 DEM 点查

## 配置文件

- 示例配置：`sync.config.example.json`
- 本地实际配置：`.sync.config.json`

Windy 前端地图 key：

- 在项目根目录创建 `.env.local`
- 添加：`VITE_MAPTILER_WEATHER_KEY=你的MapTilerWeatherKey`

DEM 在线点查接口支持环境变量：

- 本地开发默认走 Vite 代理：`/api/dem/v1/aster30m`
- 自定义接口：`VITE_DEM_API_URL=你的DEM接口地址`

## 运行方式

先安装依赖：

```sh
npm install
```

初始化移动地理数据库（创建 `fire_monitor.geodatabase`）：

```sh
npm run db:init
```

强制重建数据库：

```sh
npm run db:init -- --force
```

单次同步（仅环境场）：

```sh
npm run sync:data:once
```

持续定时同步：

```sh
npm run sync:data
```

## Himawari-9 抓取（B03/B07/B13/B14）

已在 `scripts/sync-data.mjs` 增加 `noaa-aws-s3-himawari` 数据源类型，数据源使用 NOAA Open Data on AWS（`noaa-himawari9` 桶），支持：

- 每分钟调度轮询（由 `scheduleMinutes` 控制，建议设为 `1`）
- 按 10 分钟 timeline 回看最近时段（`timelineMinutes` + `lookbackSlots`）
- 仅抓取 Band 07 / Band 13 / Band 14
- 通过 S3 `list-type=2` 接口按前缀列举对象并无签名下载
- 原始文件落盘到 `dataRoot/<targetDir>/<YYYYMMDDHHmm>/`
- 将下载记录写入 `fire_monitor.geodatabase` 的 `raw_scene`

`raw_scene` 写入字段（至少）：

- `scene_id`
- `satellite`（固定 `H09`）
- `sensor`（固定 `AHI`）
- `acq_time`
- `band`
- `roi_code`
- `file_path`
- `file_size`
- `checksum`
- `download_time`
- `download_status`

配置方式：参考 `sync.config.example.json` 中 `himawari9_ahi_b03_b07_b13_b14`，默认已配置 `bucket=noaa-himawari9` 与 `productPrefix=AHI-L1b-FLDK`，按需调整 `lookbackSlots` 后启用该 source。

下载提速参数（NOAA source）：

- `maxParallelListRequests`：并发列举时段目录（建议 `4`）
- `maxParallelDownloads`：并发下载文件（建议 `8~12`）
- `downloadTimeoutMs`：单文件下载超时
- `progressLogEvery`：下载进度日志间隔

也可以仅运行 Himawari source：

```sh
node ./scripts/sync-data.mjs --once --config ./sync.config.example.json --source himawari9_ahi_b03_b07_b13_b14

## 云端拉取、本地只取结果

已新增两套脚本：

- `scripts/cloud-pipeline.mjs`
  - 云端执行下载与算法步骤
  - 收集算法输出并发布 `manifest.json`
- `scripts/pull-cloud-results.mjs`
  - 本地按 `manifest.json` 增量拉取结果文件
  - 适合让前端或本地服务只消费处理结果

配置样例：

- `.cloud-pipeline.config.example.json`
- `.pull-cloud-results.config.example.json`

常用命令：

```bash
npm run cloud:pipeline:once
npm run pull:cloud-results:once
```

## Himawari 火点检测算法

已新增脚本：

- `scripts/detect-himawari-fire.mjs`

用途：

- 从 Himawari 遥感影像栅格中提取候选火点
- 输出 `candidate_fire.geojson` 与 `candidate_fire_summary.json`
- 可选写入 `candidate_fire` 表

输入要求：

- 必选：`B03`（用于 `Rvis`）、`B07`、`B13`、`B14`
- 可选掩膜：`land`、`nonVegetation`、`staticHot`、`highReflectance`

说明：

- 若缺少 `Rvis`，脚本仍可运行，但白天云与高反射背景剔除会降级
- 配置参考：`.detect-himawari-fire.config.example.json`

命令：

```bash
npm run detect:himawari-fire -- --config ./.detect-himawari-fire.config.example.json
```
```

启动前端：

```sh
npm run dev
```

生产构建：

```sh
npm run build
```

## 移动地理数据库设计（比赛方案）

### 1. 数据库总体设计

#### 1.1 数据库存什么

`.geodatabase` 中仅存储表和矢量要素，不存储栅格本体。

表：

- `raw_scene`：原始数据清单
- `raster_asset`：本地栅格文件索引
- `algo_config`：算法阈值与版本
- `fetch_log`：抓取日志

点要素类：

- `viirs_fire_nrt`：VIIRS 375 m 近实时火点
- `candidate_fire`：Himawari 候选火点
- `fire_event`：事件级火点
- `static_hot_source`：长期稳定假热点

面要素类：

- `roi_boundary`：研究区范围
- `mask_water`：水体掩膜
- `mask_industry`：工业热源先验区

说明：

- 移动地理数据库支持表、要素类、关系类、视图、属性域、子类型、附件等能力。
- 其本质是单文件数据库，便于拷贝与分发。
- 写入并发受限，更适合单用户或单应用写入场景。

#### 1.2 栅格怎么存

原始栅格与中间栅格统一落盘，不写入 `.geodatabase`：

- `data/raw/himawari/...`
- `data/raw/viirs/...`
- `data/derived/himawari_bt/...`
- `data/derived/features/...`

在 `raster_asset` 表中登记元数据：

- 文件路径
- 卫星
- 波段
- 时间
- ROI
- 投影
- 处理状态
- 文件校验值

关键约束：移动地理数据库不支持 `raster dataset`，因此必须采用“栅格文件在磁盘 + 元数据在库中”的分层设计。

### 2. 完整流程

#### 第 0 步：初始化工程与数据库

先创建移动地理数据库文件，例如：

- `fire_monitor.geodatabase`

然后用 GeoScene/ArcGIS 地理处理工具创建表和要素类，并统一坐标体系（比赛场景建议统一一套中国区常用坐标系，前端按展示需要再投影）。

本步骤清单：

- 创建 `.geodatabase`
- 创建表与要素类
- 为 `candidate_fire`、`viirs_fire_nrt`、`fire_event` 创建空间索引
- 预置属性域：
	- `fire_status`：`suspected` / `confirmed` / `rejected`
	- `daynight`：`D` / `N`
	- `source_sat`：`H09` / `SNPP` / `NOAA20` / `NOAA21`

补充说明：移动地理数据库可直接通过地理处理工具创建并自动加入工程，本体是磁盘上的单文件 SQLite 数据库。
