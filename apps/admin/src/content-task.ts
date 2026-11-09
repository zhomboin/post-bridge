import { useRef } from 'react';
import { useAction, useWorkspace, type Job } from './runtime';

export function useContentTask() {
  const { api } = useWorkspace();
  const action = useAction();
  const request = useRef<{ path: string; id: string } | undefined>(undefined);
  async function submit(path: string) {
    if (!request.current || request.current.path !== path)
      request.current = { path, id: crypto.randomUUID() };
    const current = request.current;
    const job = await action.run((signal) =>
      api<Job>(path, {
        method: 'POST',
        body: JSON.stringify({ request_id: current.id }),
        signal,
      }),
    );
    if (job && request.current === current) request.current = undefined;
    return job;
  }
  return { ...action, submit };
}
