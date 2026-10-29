import { useMemo, useState, type RefObject } from 'react';
import type { commandDescriptor } from '../../../shared/dsh-type.ts';

interface slashMenuOptions {
  sessionId: string;
  /** 当前输入框内容，决定斜杠菜单是否展开和过滤词 */
  input: string;
  commands: commandDescriptor[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** 选中一条命令后由调用方回填输入框 */
  onPick: (command: commandDescriptor) => void;
}

/** 斜杠命令下拉菜单的交互状态：展开、过滤、高亮、接受。 */
export const useSlashMenu = ({ sessionId, input, commands, textareaRef, onPick }: slashMenuOptions) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const query = /^\/\S*$/.test(input) ? input.slice(1).toLowerCase() : undefined;
  const open = query !== undefined && !dismissed && sessionId !== '';

  const items = useMemo(
    () =>
      query === undefined
        ? []
        : commands.filter((command) => command.name.toLowerCase().startsWith(query)),
    [commands, query],
  );

  const active = items[Math.min(activeIndex, items.length - 1)];

  /** 选中某条命令：回填输入框、收起菜单并把高亮复位。 */
  const pick = (command: commandDescriptor) => {
    onPick(command);
    setDismissed(true);
    setActiveIndex(0);
    textareaRef.current?.focus();
  };

  /** 键盘回车选中当前高亮项。 */
  const accept = () => {
    if (active !== undefined) pick(active);
  };

  const moveActive = (step: number) => {
    setActiveIndex((index) => (index + step + items.length) % items.length);
  };

  const dismiss = () => setDismissed(true);

  /** 输入内容变了：重新展开菜单并把高亮复位。 */
  const onInputChanged = () => {
    setDismissed(false);
    setActiveIndex(0);
  };

  const reset = () => {
    setDismissed(false);
    setActiveIndex(0);
  };

  return { query, open, items, active, accept, pick, moveActive, dismiss, onInputChanged, reset };
};

export type slashMenu = ReturnType<typeof useSlashMenu>;
