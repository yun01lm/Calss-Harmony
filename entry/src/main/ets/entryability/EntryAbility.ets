import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';

/**
 * 应用入口。
 *
 * 刻意保持"启动路径零开销"，与 Android 版 CalssApp 的设计一致：
 * - onCreate / onWindowStageCreate 不做初始化（数据库、解析器、OCR 全部懒加载）
 * - 首帧不等数据：页面自身带默认状态，数据到了再刷新
 */
export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 空实现：不在此处初始化任何重资源
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index');
  }
}