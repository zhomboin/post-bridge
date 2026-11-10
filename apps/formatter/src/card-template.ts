import type { FormattingCard } from './formatting-contract.js';
export type CardTemplate = 'technical' | 'checklist';
export const escapeHTML = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function cardDocument(template: CardTemplate) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none';font-src https://formatter.invalid;style-src 'unsafe-inline'"
    />
    <style>
      @font-face {
        font-family: PBChinese;
        src: url(https://formatter.invalid/chinese);
      }
      @font-face {
        font-family: PBCode;
        src: url(https://formatter.invalid/code);
      }
      * {
        box-sizing: border-box;
      }
      html,
      body {
        margin: 0;
        width: 1080px;
        height: 1440px;
        background: #f6f8fa;
        color: #182230;
      }
      body {
        font-family: PBChinese, sans-serif;
      }
      .page {
        position: relative;
        width: 1080px;
        height: 1440px;
        padding: 80px;
      }
      .content {
        height: 1220px;
        overflow: visible;
      }
      .content > h1 {
        font-size: 54px;
        line-height: 1.35;
        margin: 0 0 40px;
        font-weight: 700;
        overflow-wrap: anywhere;
      }
      p {
        font-size: 36px;
        line-height: 1.7;
        margin: 0 0 28px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      pre {
        font-family: PBCode, PBChinese, monospace;
        font-size: 28px;
        line-height: 1.55;
        padding: 28px;
        background: #fff;
        border: 2px solid #d8dee8;
        border-radius: 10px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        margin: 0 0 28px;
      }
      .footer {
        position: absolute;
        bottom: 48px;
        left: 80px;
        color: #526176;
        font-size: 26px;
      }
      .cover {
        display: flex;
        flex-direction: column;
        justify-content: center;
        height: 100%;
        border-top: 8px solid #2557c8;
      }
      .cover h1 {
        font-size: 88px;
        line-height: 1.35;
        margin: 0 0 48px;
        overflow-wrap: anywhere;
      }
      .cover p {
        font-size: 40px;
        color: #526176;
      }
      .checklist p {
        border-left: 5px solid #2557c8;
        padding-left: 24px;
      }
    </style>
  </head>
  <body>
    <main class="page ${template}">
      <section class="content"></section>
      <footer class="footer"></footer>
    </main>
  </body>
</html>
`;
}
export type RenderCard = FormattingCard & { code?: string[] };
export function cardAtoms(card: RenderCard): { html: string; text?: string }[] {
  return [
    ...card.paragraphs.map((text) => ({ html: '<p>' + escapeHTML(text) + '</p>', text })),
    ...(card.code ?? []).map((code) => ({ html: '<pre>' + escapeHTML(code) + '</pre>' })),
  ];
}
