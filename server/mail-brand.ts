/**
 * «نامهٔ سازمان» — the letterhead on every e-mail HOVIDA sends for a workspace.
 *
 * An e-mail is not a web page, and pretending otherwise is how products end up
 * with letters that look broken in half their customers' inboxes. The rules
 * here are the boring ones that actually work:
 *
 *   • **Table layout, inline styles.** Outlook (desktop) ignores modern CSS and
 *     strips <style>; tables and inline attributes survive everywhere.
 *   • **The logo travels as an attachment with a `cid:`**, not a data-URI and not
 *     a remote URL. Gmail blocks data-URI images outright; a remote URL would
 *     need a public asset host and can be blocked as tracking. A cid attachment
 *     is shown by Gmail, Outlook, Apple Mail and Yandex alike — and it keeps the
 *     company's logo off any public URL.
 *   • **Raster only.** SVG and WebP are not rendered by Outlook at all, so for
 *     those the header falls back to the workspace's wordmark instead of an
 *     empty box. The editor says so in plain Persian.
 *   • **Plain text is always sent too.** Some people read mail in a terminal;
 *     some clients treat HTML as a risk. Both parts carry the same words.
 *   • **The accent colour is the accessible one**, not the raw brand colour:
 *     a pale yellow that works on a dashboard is unreadable for 12px text.
 */
import type { BrandTokens } from '../src/lib/brand';
import { brandName, brandTokens, isBranded } from '../src/lib/brand';
import { DEFAULT_BRANDING, type OrgBranding } from '../src/types/branding';

/** Everything the renderer needs — resolved once per send, never per recipient. */
export interface MailBrand {
  /** The name in the header and footer: the workspace's own name or HOVIDA's. */
  name: string;
  /** Header rule, button/accent colour (accessible on white). */
  accent: string;
  /** Text colour for anything coloured on white (links, the header name). */
  accentInk: string;
  /** True when the workspace customised its identity at all. */
  custom: boolean;
  /** «ساخته‌شده با هویدا» — off for white-label workspaces. */
  showCredit: boolean;
  /** Closing line; empty means «add nothing» (many bodies sign themselves). */
  signoff: string;
  /** Small print under the signature. */
  footerNote: string;
  /** Raster logo, ready to attach. Null = draw the wordmark instead. */
  logo: { data: Buffer; mime: string } | null;
}

/** Logo formats every major client renders. SVG/WebP are deliberately absent. */
const EMAIL_SAFE_LOGO = ['image/png', 'image/jpeg', 'image/gif'];

export function mailBrandOf(org: {
  name: string;
  branding?: OrgBranding | null;
  messageSignature?: string;
} | null | undefined): MailBrand {
  const branding = org?.branding || DEFAULT_BRANDING;
  const tokens: BrandTokens = brandTokens(branding);
  const custom = isBranded(branding);
  const name = brandName(branding, org?.name);
  return {
    name,
    accent: tokens.vars['--color-brand-strong'] || '#1B8539',
    accentInk: tokens.vars['--color-brand-ink'] || '#1B7F36',
    custom,
    showCredit: branding.showHovidaCredit !== false,
    // A signature the workspace set globally is reused as the closing line, so
    // a letter never signs itself twice.
    signoff: (branding.email?.signoff || '').trim(),
    footerNote: (branding.email?.footerNote || '').trim(),
    logo: branding.email?.includeLogo === false ? null : rasterLogo(branding.logoDataUrl || branding.markDataUrl),
  };
}

/** Decodes a stored data-URI, but only for formats an inbox will display. */
export function rasterLogo(dataUrl: string | null | undefined): { data: Buffer; mime: string } | null {
  if (!dataUrl) return null;
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!EMAIL_SAFE_LOGO.includes(mime)) return null;
  const data = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  // 400 KB of letterhead is already rude; refuse anything absurd.
  if (!data.length || data.length > 400 * 1024) return null;
  return { data, mime };
}

export const LOGO_CID = 'brand-top@hovida.local';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Paragraphs from the plain-text body: blank line = new block, single = <br>. */
function bodyHtml(text: string): string {
  const blocks = String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks
    .map(
      (b) =>
        `<tr><td style="padding:0 0 14px 0;font-size:14px;line-height:2;color:#1d2329;font-family:Tahoma,'Segoe UI',Arial,sans-serif">${esc(
          b
        ).replace(/\n/g, '<br>')}</td></tr>`
    )
    .join('');
}

/**
 * The whole letter. `logoCid` is passed only when the logo was attached, so the
 * markup never references an image that is not there.
 */
export function renderEmailHtml(text: string, brand: MailBrand, opts: { logoCid?: string | null } = {}): string {
  const headerVisual = opts.logoCid
    ? `<img src="cid:${opts.logoCid}" alt="${esc(brand.name)}" height="30" style="display:block;border:0;height:30px;width:auto;max-height:30px" />`
    : `<span style="font-size:17px;font-weight:800;color:${brand.accentInk};letter-spacing:-0.2px;font-family:Tahoma,'Segoe UI',Arial,sans-serif">${esc(
        brand.name
      )}</span>`;

  const signoff = brand.signoff
    ? `<tr><td style="padding:6px 0 0 0;font-size:14px;line-height:2;color:#1d2329;white-space:pre-wrap;font-family:Tahoma,'Segoe UI',Arial,sans-serif">${esc(
        brand.signoff
      ).replace(/\n/g, '<br>')}</td></tr>`
    : '';

  const footerBits = [
    `<span style="font-weight:700;color:#3d4742">${esc(brand.name)}</span>`,
    brand.footerNote ? esc(brand.footerNote).replace(/\n/g, '<br>') : '',
    brand.showCredit ? 'ساخته‌شده با هویدا' : '',
  ].filter(Boolean);

  return `<!doctype html>
<html dir="rtl" lang="fa">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light only" />
<title>${esc(brand.name)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f5;padding:24px 12px">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e4e7e5;border-radius:12px;overflow:hidden">
        <!-- brand rule: the one place the company colour is unmistakable -->
        <tr><td style="height:4px;background:${brand.accent};font-size:0;line-height:0">&nbsp;</td></tr>
        <tr>
          <td style="padding:22px 26px 10px 26px" align="right">
            ${headerVisual}
          </td>
        </tr>
        <tr>
          <td style="padding:8px 26px 24px 26px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" align="right" dir="rtl">
              ${bodyHtml(text)}
              ${signoff}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 26px 20px 26px;border-top:1px solid #eceeed;font-size:11.5px;line-height:1.9;color:#6b7570;font-family:Tahoma,'Segoe UI',Arial,sans-serif" align="right">
            ${footerBits.join('<br>')}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** The inline attachment nodemailer turns into `cid:brand-top@hovida.local`. */
export function logoAttachment(brand: MailBrand): { filename: string; content: Buffer; contentType: string; cid: string; contentDisposition: 'inline' } | null {
  if (!brand.logo) return null;
  const ext = brand.logo.mime === 'image/png' ? 'png' : brand.logo.mime === 'image/gif' ? 'gif' : 'jpg';
  return {
    filename: `logo.${ext}`,
    content: brand.logo.data,
    contentType: brand.logo.mime,
    cid: LOGO_CID,
    contentDisposition: 'inline',
  };
}

/** The unbranded letter — HOVIDA's own, for workspaces that kept the defaults. */
export const HOVIDA_MAIL_BRAND: MailBrand = mailBrandOf({ name: 'هویدا' });

/** A one-line description of what a letter will look like, for the settings UI. */
export function mailBrandSummary(brand: MailBrand): string {
  const parts = [brand.logo ? 'لوگو در سربرگ' : 'نام سازمان در سربرگ'];
  if (brand.signoff) parts.push('امضای پایانی');
  if (brand.footerNote) parts.push('زیرنویس');
  parts.push(brand.showCredit ? 'با نام هویدا در پانویس' : 'بدون نام هویدا (سفیدبرچسب)');
  return parts.join(' · ');
}
