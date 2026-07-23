# Himawari 火点算法模式说明

当前实时算法采用 `paper-adapted`（论文适配）模式，不再声明为严格论文复现。

主要依据：

- Chen et al. (2023), *An adapted hourly Himawari-8 fire product for China: principle, methodology and verification*, ESSD, DOI: https://doi.org/10.5194/essd-15-1911-2023
- Chen et al. (2022), *The Fengyun-3D global active fire product: principle, methodology and validation*, ESSD, DOI: https://doi.org/10.5194/essd-14-3489-2022
- Giglio et al. (2016), *The Collection 6 MODIS active fire detection algorithm and fire products*, RSE, DOI: https://doi.org/10.1016/j.rse.2016.02.054
- Schroeder et al. (2014), *The New VIIRS 375 m active fire detection data product: Algorithm description and initial assessment*, RSE, DOI: https://doi.org/10.1016/j.rse.2013.12.008

## 已对齐的论文方法

- 使用 B07、B13、B14 与可见光反射率进行云和高温候选筛选。
- 日间候选预筛选采用两个独立条件：`T7-T13 > 20 K` 且 `T7 > 100 * Rvis + 20 K`。
- 背景高温排除采用 `T7 >= T13 + 100 * Rvis + 20 K`。
- 背景窗口按 `7、9、11、19` 像素逐级扩展，要求至少 20% 有效背景像元。
- `T7-T13` 背景标准差限制在 `2–4 K`。
- 动态阈值同时考虑太阳高度、非植被比例和云比例，分界为 60°。
- 使用云边缘、高反射地表和静态热源二次剔除。

## 工程增强

- 夜间可见光反射率缺失时，允许通过热红外绝对高温路径检测，避免 B03 缺测造成系统性漏报。
- 置信度分数使用超过动态背景阈值的标准化热异常强度，不再使用动态阈值系数本身。
- 未经过连续时次、VIIRS/MODIS 或人工确认的点统一标记为 `suspected`。
- 输出记录算法版本、模式、阈值和参考文献，便于追溯。

## 不能继承论文准确度的原因

Chen et al. (2023) 的约 80% 总体准确度依赖覆盖中国的 7000 多个热干扰源和 9900 多个光伏像元，并使用实地数据验证。当前仓库的辅助数据规模远小于论文数据，因此不能直接声称达到同等准确度。

在建立跨季节、跨区域的地面或 VIIRS/MODIS 匹配验证集之前，输出只能作为候选火点产品使用。
