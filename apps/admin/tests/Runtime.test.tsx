import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useAction } from '../src/runtime';

function ActionProbe() {
  const action = useAction();
  return (
    <>
      <button
        disabled={action.pending}
        onClick={() =>
          void action.run(async () => {
            throw new Error('可恢复错误');
          })
        }
      >
        执行操作
      </button>
      <span>{action.error}</span>
    </>
  );
}

it('严格模式重新执行 effect 后仍显示操作错误并释放按钮', async () => {
  render(
    <StrictMode>
      <ActionProbe />
    </StrictMode>,
  );
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '执行操作' })));
  expect(screen.getByText('可恢复错误')).toBeTruthy();
  expect((screen.getByRole('button', { name: '执行操作' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});
