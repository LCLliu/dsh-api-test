import type { commandDescriptor } from '../../../shared/dsh-type.ts';

interface slashMenuProps {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string;
  items: commandDescriptor[];
  active?: commandDescriptor;
  onPick: (command: commandDescriptor) => void;
}

/** 输入 / 时浮出的命令列表，只负责展示和点击。 */
export function SlashMenu({ status, error, items, active, onPick }: slashMenuProps) {
  return (
    <div className='slash-menu'>
      {status !== 'ready' ? (
        <div className='slash-note'>
          {status === 'error' ? `命令加载失败：${error}` : '正在加载命令…'}
        </div>
      ) : items.length === 0 ? (
        <div className='slash-note'>没有匹配的命令</div>
      ) : (
        items.map((command) => (
          <button
            key={command.name}
            type='button'
            className={`slash-item${command === active ? ' active' : ''}`}
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(command);
            }}
          >
            <span className='slash-name'>/{command.name}</span>
            <span className='slash-desc'>{command.description}</span>
            {command.input?.hint !== undefined && (
              <span className='slash-hint'>{command.input.hint}</span>
            )}
          </button>
        ))
      )}
    </div>
  );
}
