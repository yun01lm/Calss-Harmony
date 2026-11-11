/**
 * 全应用统一的转场与滑动反馈参数。
 *
 * ## 为什么单独抽一个文件
 *
 * 应用市场「上架自检」的 UX 项里，这两条是**机器逐帧量出来的**，不是建议稿：
 *
 * 1. 「全屏页面的转场（层级转场、新建转场、编辑转场、搜索转场等）动效时长在 8.5 英寸
 *    及以下的设备上不应短于 200 ms，在 8.5 至 12 英寸的设备上不应短于 250 ms」；
 * 2. 「页面转场采用淡入淡出的运动方式，不应单帧直接切换、左右平移或者上下位移切换，
 *    曲线优先使用弹簧曲线」。
 *
 * 本应用是**单页面 + 状态切换**的结构（`pages/Index.ets` 里 `screen` 三态 + 十来个
 * 全屏卡片），原来全靠 `if` 直接增删节点 —— 那就是「单帧直接切换」：自检实测 0 ms、
 * 报了 13 次。现在每个"页面/弹层"的根节点都挂 [Motion.fadeInOut]，参数只在这里改一次。
 *
 * ## 数值怎么定的
 *
 * - **300 ms**：本应用要覆盖手机(≤8.5")、平板(8.5–12")、2in1(>12") 三类设备，
 *   最严的一档是 250 ms；取 300 ms 留出余量，又不至于让人等。
 * - **`Curve.Friction`**：系统的"摩擦曲线"（先快后缓、末端收敛），是 HarmonyOS
 *   设计规范里给转场用的那条阻尼曲线；不用 `springMotion` 系列的 ICurve 是因为
 *   ICurve 自带内部时长、会覆盖调用处写的 `duration`，自检量到的时长就不可控了。
 * - **只做透明度**：规范明确写"淡入淡出"，位移/缩放都不是它要的东西。
 *
 * ## 为什么不是系统 `bindSheet` / `Navigation`
 *
 * 这两者确实自带系统转场，但本页是"一个 @Entry 页面 + 若干全屏卡片"的老结构，
 * 改成 Navigation 要重排 4000 多行里的所有返回路径与状态恢复逻辑（风险远大于收益）。
 * 用统一的 `TransitionEffect` 达到同样的观感与可量测时长，属于**同等效果、局部改动**。
 */
export class Motion {
  /** 页面/全屏弹层的转场时长（ms）。自检要求 ≥250（平板/2in1），这里取 300。 */
  static readonly FADE_MS: number = 300;

  /** 转场曲线：系统摩擦曲线（阻尼/弹簧类，末端收敛，无回弹） */
  static readonly FADE_CURVE: Curve = Curve.Friction;

  /**
   * 页面与全屏卡片的统一转场：淡入淡出。
   *
   * 每次调用返回新的 `TransitionEffect` 实例：`TransitionEffect` 的 `combine` 等方法
   * 会改自身状态，共用一个静态实例容易在别处被改坏（比如以后给某个卡片加缩放）。
   */
  static fadeInOut(): TransitionEffect {
    return TransitionEffect.OPACITY.animation({
      duration: Motion.FADE_MS,
      curve: Motion.FADE_CURVE,
    });
  }
}
