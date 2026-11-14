import { useEffect, useState } from 'react';
import { useWorkspace, errorText } from './runtime';
import type { FormattingJob } from './formatting-contract';
export const formattingLabels: Record<string, string> = {
  queued: '排队中',
  running: '处理中',
  needs_review: '待调整',
  succeeded: '已生成',
  failed: '生成失败',
  cancelled: '已取消',
  adopted: '已采用',
  analyzing: '分析原稿',
  generating: '生成内容',
  validating: '校验内容',
  rendering: '生成卡片',
  finished: '处理完成',
  provider_credentials: 'DeepSeek 凭据不可用，请检查私有配置。',
  provider_rate_limited: 'DeepSeek 调用达到限额，请稍后重试。',
  provider_interrupted: '模型响应中断，可能已产生用量，请核对后重新生成。',
  provider_incomplete: '模型输出未完成，请缩小内容后重新生成。',
  provider_invalid_json: '模型未返回有效内容，请重新生成。',
  provider_unavailable: '模型服务暂不可用。',
  provider_invalid_response: '模型响应不符合要求。',
  renderer_unavailable: '排版服务暂不可用。',
  formatting_quota: '格式化存储或用量达到上限。',
  content_invalid: '内容未通过保真校验，请重新生成或人工编辑。',
  wechat_image_changed: '图片位置发生变化，请重新选择相关素材。',
  source_unavailable: '来源内容或授权已失效，请重新核对。',
  processing_interrupted: '处理已中断，请核对后重新生成。',
  processing_failed: '处理未完成，请稍后重试。',
};
export function useFormattingJob(id?: string) {
  const { api } = useWorkspace();
  const [job, setJob] = useState<FormattingJob>();
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    setJob((current) => (current?.id === id ? current : undefined));
    setError('');
    if (!id) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const result = await api<FormattingJob>('/api/formatting-jobs/' + encodeURIComponent(id), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setJob(result);
        setError('');
        if (['queued', 'running'].includes(result.status))
          timer = setTimeout(() => void load(), 1000);
      } catch (error) {
        if (!controller.signal.aborted) {
          setJob(undefined);
          setError(errorText(error));
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, id, refresh]);
  const updateJob = (value: FormattingJob) => {
    setJob(value);
    if (['queued', 'running'].includes(value.status)) setRefresh((current) => current + 1);
  };
  return {
    job: job?.id === id ? job : undefined,
    setJob: updateJob,
    error,
    reload: () => setRefresh((current) => current + 1),
  };
}
