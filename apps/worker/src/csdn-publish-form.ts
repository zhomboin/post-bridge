import type { Locator, Page, Request } from 'playwright';
import type { PublishOptions } from './types.js';

export const visibilityValues = { public: 'public', private: 'private', fans: 'read_need_fans', vip: 'read_need_vip' };
export const declarationValues = { none: 0, ai_assisted: 1, online_recreation: 2, personal_opinion: 3 };
export const templateValues = { default: -1, simple: 4, moyan: 3 };
const visibilityControls = { public: 'public', private: 'private', fans: 'needfans', vip: 'needvip' };
const templateControls = { default: 'default', simple: 'simple', moyan: 'mogrow' };
const declarationLabels = {
  none: '无声明', ai_assisted: '部分内容由AI辅助生成', online_recreation: '内容来源网络，进行整合/再创作', personal_opinion: '个人观点，仅供参考',
};

const tagSearchPath = '/blog/phoenix/console/v1/tag/search-recommend-tag';

export function isPublishTagURL(url: URL, fixtureOrigin?: string): boolean {
  return (url.origin === 'https://bizapi.csdn.net' || url.origin === fixtureOrigin) && url.pathname === tagSearchPath && !url.search;
}

export function publishTagKey(request: Request, fixtureOrigin?: string): string | undefined {
  if (request.method() !== 'POST' || !isPublishTagURL(new URL(request.url()), fixtureOrigin)) return undefined;
  try {
    const body = request.postDataJSON() as { key?: unknown; page?: unknown; page_size?: unknown; platform?: unknown };
    if (body && typeof body.key === 'string' && body.page === 0 && body.page_size === 1000 && body.platform === 'pc' &&
        Object.keys(body).length === 4) return body.key;
  } catch { /* 未识别的请求不会放行。 */ }
}

async function setChecked(scope: Locator, control: Locator, checked: boolean): Promise<void> {
  const id = await control.getAttribute('id');
  if (await control.isChecked() !== checked) {
    if (id && /^[\w-]+$/.test(id) && await scope.locator('label[for="' + id + '"]').count() === 1) {
      await scope.locator('label[for="' + id + '"]').click();
    } else {
      const label = control.locator('xpath=ancestor::label[1]');
      if (await label.count() === 1) await label.click();
      else await control.setChecked(checked);
    }
  }
  if (await control.isChecked() !== checked) throw new Error('表单选项未生效');
}

async function fillTags(modal: Locator, tags: string[], timeout: number, fixtureOrigin?: string): Promise<void> {
  const selected = modal.locator('.mark_selection_title_el_tag .mark_selection_box_el_tag');
  if ((await selected.allTextContents()).map(label => label.trim()).join(',') === tags.join(',')) return;
  const previous = await selected.count();
  for (let i = 0; i < previous; i++) await selected.first().locator('.el-tag__close').click();
  const panel = modal.locator('.mark_selection_box');
  for (const tag of tags) {
    if (!await panel.isVisible()) await modal.locator('button:text-is("添加文章标签")').click();
    const input = panel.getByPlaceholder('请输入文字搜索，Enter键入可添加自定义标签', { exact: true });
    const search = modal.page().waitForResponse(response => publishTagKey(response.request(), fixtureOrigin) === tag,
      { timeout: Math.min(timeout, 2000) }).catch(() => undefined);
    await input.fill(tag);
    const response = await search;
    const name = new RegExp('^\\s*' + tag.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&') + '\\s*$');
    const match = panel.locator('.el-autocomplete-suggestion li').filter({ hasText: name, visible: true });
    if (response?.ok()) await match.first().waitFor({ state: 'visible', timeout: 350 }).catch(() => {});
    if (await match.count() === 1) await match.click();
    else await input.press('Enter');
    await selected.filter({ hasText: tag }).last().waitFor({ state: 'visible' });
  }
  if (await panel.isVisible()) await panel.getByRole('button', { name: '关闭', exact: true }).click();
  if ((await selected.allTextContents()).map(label => label.trim()).join(',') !== tags.join(',')) throw new Error('文章标签未生效');
}

async function fillCategories(modal: Locator, categories: string[]): Promise<void> {
  const selection = modal.locator('.tag__box').filter({ has: modal.page().locator('input[name="categories"]') });
  const input = selection.locator('input[name="categories"]');
  const existing = await input.inputValue();
  if (existing === categories.join(',') || (existing === '0' && !categories.length)) return;
  const remove = selection.locator('.tag__btn-tag-delete');
  const previous = await remove.count();
  for (let i = 0; i < previous; i++) await remove.first().click();
  if (categories.length) {
    await selection.locator('.tag__item-list').hover();
    const panel = selection.locator('.tag__options-content');
    for (const category of categories) {
      const label = panel.locator('.tag__option-label').filter({ has: modal.page().getByText(category, { exact: true }) });
      await setChecked(panel, label.locator('input[type="checkbox"]'), true);
    }
    await panel.getByRole('button', { name: '关闭', exact: true }).click();
  }
  if (await input.inputValue() !== categories.join(',')) throw new Error('分类专栏未生效');
}

export async function preparePublishForm(page: Page, options: PublishOptions, timeout: number, fixtureOrigin?: string): Promise<Locator> {
  await page.locator('.btn-publish:text-is("发布文章")').click();
  const modal = page.locator('.modal__publish-article').filter({ visible: true });
  await modal.waitFor({ state: 'visible' });
  await fillTags(modal, options.tags, timeout, fixtureOrigin);
  await fillCategories(modal, options.categories);
  await modal.locator('.txt-desc textarea').fill(options.summary);
  await setChecked(modal, modal.locator('input[type="radio"]#' + options.article_type), true);
  if (options.article_type !== 'original') {
    await modal.getByPlaceholder('请填写原文链接', { exact: true }).fill(options.original_url!);
    await setChecked(modal, modal.locator('input[type="checkbox"]#chkAuthorized'), true);
  }
  await setChecked(modal, modal.locator('input[type="radio"]#' + visibilityControls[options.visibility]), true);
  await setChecked(modal, modal.locator('input[type="radio"][id^="article-template-' + templateControls[options.template] + '-"]:not([disabled])'), true);
  const declaration = modal.locator('.creation-statement-select input');
  const declarationLabel = declarationLabels[options.creation_declaration];
  if (await declaration.inputValue() !== declarationLabel) {
    await declaration.click();
    await page.locator('.el-select-dropdown__item').filter({ visible: true }).getByText(declarationLabel, { exact: true }).click();
    if (await declaration.inputValue() !== declarationLabel) throw new Error('创作声明未生效');
  }
  const multi = modal.locator('.multi-platform-publish');
  if (await multi.count()) await setChecked(modal, multi.locator('#multiPlatformPublishNo'), true);
  if (options.visibility === 'public') await setChecked(modal, modal.locator('.gitcode-box input[type="checkbox"]'), false);
  const cover = modal.locator('.btn-remove-coverimg').filter({ visible: true });
  if (await cover.count()) await cover.click();
  return modal.locator('.publish-article-modal__footer button:text-is("发布文章")');
}
