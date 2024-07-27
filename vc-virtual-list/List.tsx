import type { PropType, Component, CSSProperties } from 'vue';
import {
  shallowRef,
  toRaw,
  onMounted,
  onUpdated,
  ref,
  defineComponent,
  watchEffect,
  computed,
  nextTick,
  onBeforeUnmount,
  reactive,
  watch,
} from 'vue';
import type { Key } from '../_util/type';
import Filler from './Filler';
import Item from './Item';
import ScrollBar from './ScrollBar';
import useHeights from './hooks/useHeights';
import useScrollTo from './hooks/useScrollTo';
import useFrameWheel from './hooks/useFrameWheel';
import useMobileTouchMove from './hooks/useMobileTouchMove';
import useOriginScroll from './hooks/useOriginScroll';
import PropTypes from '../_util/vue-types';
import classNames from '../_util/classNames';
import type { RenderFunc, SharedConfig } from './interface';
import supportsPassive from '../_util/supportsPassive';

const EMPTY_DATA = [];

const ScrollStyle: CSSProperties = {
  overflowY: 'auto',
  overflowAnchor: 'none',
};

export type ScrollAlign = 'top' | 'bottom' | 'auto';
export type ScrollConfig =
  | {
      index: number;
      align?: ScrollAlign;
      offset?: number;
    }
  | {
      key: Key;
      align?: ScrollAlign;
      offset?: number;
    };
export type ScrollTo = (arg: number | ScrollConfig) => void;

function renderChildren<T>(
  list: T[],
  startIndex: number,
  endIndex: number,
  setNodeRef: (item: T, element: HTMLElement) => void,
  renderFunc: RenderFunc<T>,
  { getKey }: SharedConfig<T>,
) {
  console.log('list',list)
  return list.slice(startIndex, endIndex + 1).map((item, index) => {
    const eleIndex = startIndex + index;
    const node = renderFunc(item, eleIndex, {
      // style: status === 'MEASURE_START' ? { visibility: 'hidden' } : {},
    });
    const key = getKey(item);
    return (
      <Item key={key} setRef={ele => setNodeRef(item, ele as HTMLElement)}>
        {node}
      </Item>
    );
  });
}

export interface ListState {
  scrollTop: number;
  scrollMoving: boolean;
}

const List = defineComponent({
  compatConfig: { MODE: 3 },
  name: 'List',
  inheritAttrs: false,
  props: {
    prefixCls: String,
    data: PropTypes.array,
    height: Number,
    itemHeight: Number,
    /** If not match virtual scroll condition, Set List still use height of container. */
    fullHeight: { type: Boolean, default: undefined },
    itemKey: {
      type: [String, Number, Function] as PropType<Key | ((item: Record<string, any>) => Key)>,
      required: true,
    },
    component: {
      type: [String, Object] as PropType<string | Component>,
    },
    /** Set `false` will always use real scroll instead of virtual one */
    virtual: { type: Boolean, default: undefined },
    children: Function,
    onScroll: Function,
    onMousedown: Function,
    onMouseenter: Function,
    onVisibleChange: Function as PropType<(visibleList: any[], fullList: any[]) => void>,
  },
  setup(props, { expose }) {
    // ================================= MISC =================================
    const useVirtual = computed(() => {
      const { height, itemHeight, virtual } = props;
      return !!(virtual !== false && height && itemHeight);
    });
    const inVirtual = computed(() => {
      const { height, itemHeight, data } = props;
      return useVirtual.value && data && itemHeight * data.length > height;
    });

    const state = reactive<ListState>({
      scrollTop: 0,
      scrollMoving: false,
    });
    const data = computed(() => {
      return props.data || EMPTY_DATA;
    });
    const mergedData = shallowRef([]);
    watch(
      data,
      () => {
        mergedData.value = toRaw(data.value).slice();
      },
      { immediate: true },
    );
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const itemKey = shallowRef((_item: Record<string, any>) => undefined);
    watch(
      () => props.itemKey,
      val => {
        if (typeof val === 'function') {
          itemKey.value = val;
        } else {
          itemKey.value = item => item?.[val];
        }
      },
      { immediate: true },
    );
    const componentRef = ref<HTMLDivElement>();
    const fillerInnerRef = ref<HTMLDivElement>();
    const scrollBarRef = ref<any>(); // Hack on scrollbar to enable flash call
    // =============================== Item Key ===============================
    const getKey = (item: Record<string, any>) => {
      return itemKey.value(item);
    };

    const sharedConfig = {
      getKey,
    };

    // ================================ Scroll ================================
    function syncScrollTop(newTop: number | ((prev: number) => number)) {
      let value: number;
      if (typeof newTop === 'function') {
        value = newTop(state.scrollTop);
      } else {
        value = newTop;
      }

      const alignedTop = keepInRange(value);

      if (componentRef.value) {
        componentRef.value.scrollTop = alignedTop;
      }
      state.scrollTop = alignedTop;
    }

    // ================================ Height ================================
    const [setInstance, collectHeight, heights, updatedMark] = useHeights(
      mergedData,
      getKey,
      null,
      null,
    );

    const calRes = reactive<{
      scrollHeight?: number;
      start?: number;
      end?: number;
      offset?: number;
    }>({
      scrollHeight: undefined,
      start: 0,
      end: 0,
      offset: undefined,
    });

    const offsetHeight = ref(0);
    onMounted(() => {
      nextTick(() => {
        offsetHeight.value = fillerInnerRef.value?.offsetHeight || 0;
      });
    });
    onUpdated(() => {
      nextTick(() => {
        offsetHeight.value = fillerInnerRef.value?.offsetHeight || 0;
      });
    });
    watch(
      [useVirtual, mergedData],
      () => {
        if (!useVirtual.value) {
          Object.assign(calRes, {
            scrollHeight: undefined,
            start: 0,
            end: mergedData.value.length - 1,
            offset: undefined,
          });
        }
      },
      { immediate: true },
    );
    watch(
      [useVirtual, mergedData, offsetHeight, inVirtual],
      () => {
        // Always use virtual scroll bar in avoid shaking
        if (useVirtual.value && !inVirtual.value) {
          Object.assign(calRes, {
            scrollHeight: offsetHeight.value,
            start: 0,
            end: mergedData.value.length - 1,
            offset: undefined,
          });
        }
        if (componentRef.value) {
          state.scrollTop = componentRef.value.scrollTop;
        }
      },
      {
        immediate: true,
      },
    );
    watch(
      [
        inVirtual, // 监听是否启用虚拟滚动
        useVirtual, // 监听是否应该使用虚拟滚动（基于某些条件如高度和项目高度）
        () => state.scrollTop, // 监听滚动位置的变化
        mergedData, // 监听数据的变化
        updatedMark, // 监听特定的更新标记，可能用于优化渲染
        () => props.height, // 监听组件高度的变化
        offsetHeight, // 监听偏移高度的变化
      ],
      () => {
        if (!useVirtual.value || !inVirtual.value) {
          return; // 如果不使用虚拟滚动，则不执行后续代码
        }

        let itemTop = 0; // 初始化当前项顶部的位置
        let startIndex: number | undefined; // 初始化起始索引
        let startOffset: number | undefined; // 初始化起始偏移
        let endIndex: number | undefined; // 初始化结束索引
        const dataLen = mergedData.value.length; // 数据长度
        const data = mergedData.value; // 当前的数据数组
        const scrollTop = state.scrollTop; // 当前的滚动位置
        const { itemHeight, height } = props; // 从props中获取项高和组件高度
        const scrollTopHeight = scrollTop + height; // 计算滚动顶部加上组件高度的值

        for (let i = 0; i < dataLen; i += 1) {
          const item = data[i]; // 获取当前项
          const key = getKey(item); // 获取当前项的键

          let cacheHeight = heights.get(key); // 尝试从高度缓存中获取当前项的高度
          if (cacheHeight === undefined) {
            cacheHeight = itemHeight; // 如果未定义，则使用默认项高
          }
          const currentItemBottom = itemTop + cacheHeight; // 计算当前项底部的位置

          if (startIndex === undefined && currentItemBottom >= scrollTop) {
            startIndex = i; // 确定渲染的起始索引
            startOffset = itemTop; // 确定起始偏移
          }

          // 检查项底部是否在可视范围内，我们将为动画用途渲染额外的一项
          if (endIndex === undefined && currentItemBottom > scrollTopHeight) {
            endIndex = i; // 确定渲染的结束索引
          }

          itemTop = currentItemBottom; // 更新itemTop为当前项底部的位置，为下一项做准备
        }

        // 当滚动位置在末尾但数据减少到较小数量时会触及此情况
        if (startIndex === undefined) {
          startIndex = 0; // 设置默认起始索引
          startOffset = 0; // 设置默认起始偏移
          endIndex = Math.ceil(height / itemHeight); // 设置默认结束索引
        }
        if (endIndex === undefined) {
          endIndex = dataLen - 1; // 确保有结束索引
        }

        // 为了改善滚动体验，给缓存添加一项
        endIndex = Math.min(endIndex + 1, dataLen); // 确保结束索引不超出数据长度
        Object.assign(calRes, {
          scrollHeight: itemTop, // 设置滚动高度为最后一项的底部位置
          start: startIndex, // 设置可视区域的起始索引
          end: endIndex, // 设置可视区域的结束索引
          offset: startOffset, // 设置起始偏移
        });
      },
      { immediate: true }, // 立即执行侦听器
    );

    // =============================== In Range ===============================
    const maxScrollHeight = computed(() => calRes.scrollHeight! - props.height!);

    function keepInRange(newScrollTop: number) {
      let newTop = newScrollTop;
      if (!Number.isNaN(maxScrollHeight.value)) {
        newTop = Math.min(newTop, maxScrollHeight.value);
      }
      newTop = Math.max(newTop, 0);
      return newTop;
    }

    const isScrollAtTop = computed(() => state.scrollTop <= 0);
    const isScrollAtBottom = computed(() => state.scrollTop >= maxScrollHeight.value);

    const originScroll = useOriginScroll(isScrollAtTop, isScrollAtBottom);

    // ================================ Scroll ================================
    function onScrollBar(newScrollTop: number) {
      const newTop = newScrollTop;
      syncScrollTop(newTop);
    }

    // When data size reduce. It may trigger native scroll event back to fit scroll position
    function onFallbackScroll(e: UIEvent) {
      const { scrollTop: newScrollTop } = e.currentTarget as Element;
      if (newScrollTop !== state.scrollTop) {
        syncScrollTop(newScrollTop);
      }

      // Trigger origin onScroll
      props.onScroll?.(e);
    }

    // Since this added in global,should use ref to keep update
    const [onRawWheel, onFireFoxScroll] = useFrameWheel(
      useVirtual,
      isScrollAtTop,
      isScrollAtBottom,
      offsetY => {
        syncScrollTop(top => {
          const newTop = top + offsetY;
          return newTop;
        });
      },
    );

    // Mobile touch move
    useMobileTouchMove(useVirtual, componentRef, (deltaY, smoothOffset) => {
      if (originScroll(deltaY, smoothOffset)) {
        return false;
      }

      onRawWheel({ preventDefault() {}, deltaY } as WheelEvent);
      return true;
    });
    // Firefox only
    function onMozMousePixelScroll(e: MouseEvent) {
      if (useVirtual.value) {
        e.preventDefault();
      }
    }
    const removeEventListener = () => {
      if (componentRef.value) {
        componentRef.value.removeEventListener(
          'wheel',
          onRawWheel,
          supportsPassive ? ({ passive: false } as EventListenerOptions) : false,
        );
        componentRef.value.removeEventListener('DOMMouseScroll', onFireFoxScroll as any);
        componentRef.value.removeEventListener('MozMousePixelScroll', onMozMousePixelScroll as any);
      }
    };
    watchEffect(() => {
      nextTick(() => {
        if (componentRef.value) {
          removeEventListener();
          componentRef.value.addEventListener(
            'wheel',
            onRawWheel,
            supportsPassive ? ({ passive: false } as EventListenerOptions) : false,
          );
          componentRef.value.addEventListener('DOMMouseScroll', onFireFoxScroll as any);
          componentRef.value.addEventListener('MozMousePixelScroll', onMozMousePixelScroll as any);
        }
      });
    });

    onBeforeUnmount(() => {
      removeEventListener();
    });

    // ================================= Ref ==================================
    const scrollTo = useScrollTo(
      componentRef,
      mergedData,
      heights,
      props,
      getKey,
      collectHeight,
      syncScrollTop,
      () => {
        scrollBarRef.value?.delayHidden();
      },
    );

    expose({
      scrollTo,
    });

    const componentStyle = computed(() => {
      let cs: CSSProperties | null = null;
      if (props.height) {
        cs = { [props.fullHeight ? 'height' : 'maxHeight']: props.height + 'px', ...ScrollStyle };

        if (useVirtual.value) {
          cs!.overflowY = 'hidden';

          if (state.scrollMoving) {
            cs!.pointerEvents = 'none';
          }
        }
      }
      return cs;
    });

    // ================================ Effect ================================
    /** We need told outside that some list not rendered */
    watch(
      [() => calRes.start, () => calRes.end, mergedData],
      () => {
        if (props.onVisibleChange) {
          const renderList = mergedData.value.slice(calRes.start, calRes.end + 1);

          props.onVisibleChange(renderList, mergedData.value);
        }
      },
      { flush: 'post' },
    );

    return {
      state,
      mergedData,
      componentStyle,
      onFallbackScroll,
      onScrollBar,
      componentRef,
      useVirtual,
      calRes,
      collectHeight,
      setInstance,
      sharedConfig,
      scrollBarRef,
      fillerInnerRef,
    };
  },
  render() {
    const {
      prefixCls = 'rc-virtual-list',
      height,
      itemHeight,
      // eslint-disable-next-line no-unused-vars
      fullHeight,
      data,
      itemKey,
      virtual,
      component: Component = 'div',
      onScroll,
      children = this.$slots.default,
      style,
      class: className,
      ...restProps
    } = { ...this.$props, ...this.$attrs } as any;
    const mergedClassName = classNames(prefixCls, className);
    const { scrollTop } = this.state;
    const { scrollHeight, offset, start, end } = this.calRes;
    const {
      componentStyle,
      onFallbackScroll,
      onScrollBar,
      useVirtual,
      collectHeight,
      sharedConfig,
      setInstance,
      mergedData,
    } = this;
    return (
      <div
        style={{
          ...style,
          position: 'relative',
        }}
        class={mergedClassName}
        {...restProps}
      >
        <Component
          class={`${prefixCls}-holder`}
          style={componentStyle}
          ref="componentRef"
          onScroll={onFallbackScroll}
        >
          <Filler
            prefixCls={prefixCls}
            height={scrollHeight}
            offset={offset}
            onInnerResize={collectHeight}
            ref="fillerInnerRef"
            v-slots={{
              default: () =>
                renderChildren(mergedData, start, end, setInstance, children, sharedConfig),
            }}
          ></Filler>
        </Component>

        {useVirtual && (
          <ScrollBar
            ref="scrollBarRef"
            prefixCls={prefixCls}
            scrollTop={scrollTop}
            height={height}
            scrollHeight={scrollHeight}
            count={mergedData.length}
            onScroll={onScrollBar}
            onStartMove={() => {
              this.state.scrollMoving = true;
            }}
            onStopMove={() => {
              this.state.scrollMoving = false;
            }}
          />
        )}
      </div>
    );
  },
});

export default List;
