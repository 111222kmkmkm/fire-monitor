# 线上接入 west-b70 生产模型（GitHub 云端主链路）

## 真实在线链路（以 GitHub Actions 为准）

```text
.github/workflows/fire-monitor-cloud.yml
  → npm run config:github-actions
      生成 config/process-himawari-fire.github.json（含 v15Scorer）
  → pip install numpy pandas pyarrow lightgbm
  → 校验 models/himawari-fire-recognition-production/*
  → restore 时序 cache
  → node scripts/cloud-pipeline.mjs --once
        → python scripts/process-himawari-fire.py
              --config ./config/process-himawari-fire.github.json
              物理候选 → west-b70 重打分 + 西部 Top50
  → 发布 GitHub Pages:
        algorithm/latest/candidate_fire*.geojson
        algorithm/latest/candidate_fire_summary.json
        algorithm/latest/candidate_fire_v15_scorer_summary.json
```

本地 `npm run process:himawari-fire` 不是云端主链路；云端每 ~5 分钟跑上述 workflow。

## 关键文件
| 文件 | 作用 |
| --- | --- |
| `models/himawari-fire-recognition-production/` | **必须入库**的生产模型（~1.2MB） |
| `scripts/himawari_fire_v15_online_scorer.py` | 在线 scorer |
| `scripts/process-himawari-fire.py` | 检测后挂接 scorer |
| `scripts/write-github-actions-config.mjs` | 每次云端生成带 `v15Scorer` 的配置 |
| `.github/workflows/fire-monitor-cloud.yml` | 安装依赖 / 校验模型 / 时序 cache |
| `requirements-himawari-fire-cloud.txt` | 云端最小依赖清单 |

## 策略
| 区域 | 行为 |
| --- | --- |
| 西部 lon&lt;105 | west-b70 模型分（prob×10）+ Top50 |
| 非西部 | 物理规则分 |
| 官方确认点 | 不被 Top50 丢弃 |
| 云端 scorer 异常 | `failOpen=true` 回退物理规则，summary 记 error |

## 关闭
生成配置里设 `v15Scorer.enabled=false`，或改 `write-github-actions-config.mjs` 后推送。

## 上线检查清单
1. 提交并推送 `models/himawari-fire-recognition-production/**`
2. 推送 scorer / process / write-github-actions-config / workflow
3. Actions 日志出现 `v15Scorer` summary，且 `enabled=true`、无持续 `failOpen` error
4. Pages 上 `candidate_fire.geojson` 西部点 `diagnostics.scoreSource=v15-west-b70`
