import * as React from "react";

/**
 * 把「窗口内容区能缩到多窄」告诉主进程。
 *
 * 写死一个 minWidth 必然要么挡住用户缩窗口、要么挡不住布局被压坏,所以这个数由
 * 实测的布局需求推出来:chrome(sidebar + 窗口边框)= 窗口宽 - 面板行的宽,全是实测值。
 *
 * 关键在于额度里替面板留的是**用户拖出来的宽度**而不是它的可用性下限。于是「面板以
 * 期望宽度展开所需的宽度」既是窗口要长到的目标、也是窗口能缩到的下限 —— 窗口去适应
 * 内容,而不是把内容压进窗口。这几件事因此自动自洽,不需要额外分支:
 *   · 点开面板 → 窗口不够就正好长到那个宽度,不多也不少
 *   · 面板开着 → 窗口再也缩不到会挤压面板的程度
 *   · 拖窄面板 → 额度跟着降,窗口立刻又能缩了
 *   · 拖宽面板 → 面板宽度已被 Panel 的 minSize 约束夹在这一行之内,算出的额度最多
 *     等于当前窗口宽,所以永远不会反向把窗口越撑越大
 *   · 展开 sidebar → chrome 变大 → 窗口跟着长,面板与聊天区都保持原宽
 *
 * `reservedWidth` 必须来自**意图**(面板开关按钮的状态)而不是面板实际是否展开:
 * 用实际会死锁 —— 空间不足 → 折叠 → 不留额度 → 窗口不被撑大 → 永远不足。
 */
export function useWindowMinWidth({
  elementRef,
  contentMinWidth,
  reservedWidth,
}: {
  /** 聊天区与右侧面板共处的那一行容器。chrome = 窗口宽 - 它的宽 */
  elementRef: React.RefObject<HTMLElement | null>;
  /** 这一行里不可压缩的部分(聊天区下限)。0 = 尚未测到,此时不施加任何约束 */
  contentMinWidth: number;
  /** 额外要替右侧面板留出的额度。面板不该展开时为 0 */
  reservedWidth: number;
}) {
  /**
   * 这两个值只喂一次 IPC、不参与渲染,所以经 ref 读取而不进 effect 依赖 ——
   * 否则它们一变就要重建 ResizeObserver,而观察本身与它们无关。
   */
  const latest = React.useRef({ contentMinWidth, reservedWidth });
  latest.current = { contentMinWidth, reservedWidth };

  const report = React.useCallback(() => {
    const element = elementRef.current;
    if (!element) return;
    const { contentMinWidth, reservedWidth } = latest.current;
    if (contentMinWidth <= 0) return;
    const chrome = window.innerWidth - element.clientWidth;
    window.api?.window.setMinimumWidth?.(contentMinWidth + chrome + reservedWidth);
  }, [elementRef]);

  /**
   * sidebar 折叠不改变面板之间的比例,布局回调不会触发,所以 chrome 只能靠观察这一行
   * 容器得到。
   *
   * 只在**变化停下来的那一帧**上报:sidebar 折叠是 200ms 里连续变宽,中间每一帧算出的
   * chrome 都还没走完,而每帧一次 IPC 会让主进程逐帧 setMinimumSize / setBounds ——
   * Win11 上一次窗口 resize 就要过 DWM 并重新布局整页,十几次连着做必然掉帧。
   *
   * 判稳用「与上一帧同宽」而不是定时器:窗口拖拽一停顿就立刻跟上,只滞后一帧,
   * 不必为了躲开一个动画而给所有场景压上固定延迟。轮询只读 clientWidth,
   * 且发生在这一帧本来就要做的布局之前,不额外引入布局。
   */
  React.useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let frame = 0;
    let previous = -1;
    const reportWhenSettled = () => {
      const width = element.clientWidth;
      if (width !== previous) {
        previous = width;
        frame = requestAnimationFrame(reportWhenSettled);
        return;
      }
      frame = 0;
      report();
    };
    const observer = new ResizeObserver(() => {
      // 又动了,之前那轮判稳作废,从这一帧重新起算
      previous = -1;
      if (!frame) frame = requestAnimationFrame(reportWhenSettled);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [elementRef, report]);

  // 下限或额度自己变了(测到输入区边界、拖宽面板、开关面板),与容器尺寸无关,补报一次
  // biome-ignore lint/correctness/useExhaustiveDependencies: 需在 contentMinWidth / reservedWidth 变化时主动重新触发 report
  React.useEffect(() => {
    report();
  }, [report, contentMinWidth, reservedWidth]);
}
