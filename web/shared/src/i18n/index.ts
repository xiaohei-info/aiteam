/**
 * i18n（08 §12.2）。轻量、框架无关的翻译注册表，默认 zh-CN。
 *
 * 设计取舍：不引第三方 i18n 库（最小必要）。各端注册自己的 messages，
 * 共享层只提供 catalog/插值/回退机制。key 缺失回退 key 本身（不抛错、不崩 UI）。
 */

export type Locale = string;

/** 扁平 key→模板 的 message 表，模板用 {name} 占位。 */
export type Messages = Record<string, string>;

export type LocaleCatalog = Record<Locale, Messages>;

export type TranslateParams = Record<string, string | number>;

export interface I18nOptions {
  locale: Locale;
  fallbackLocale?: Locale;
  catalog: LocaleCatalog;
}

export const DEFAULT_LOCALE: Locale = "zh-CN";

/** {name} 占位插值；缺参保留原占位符（便于发现漏传）。 */
function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

export class I18n {
  private locale: Locale;
  private readonly fallbackLocale: Locale;
  private readonly catalog: LocaleCatalog;
  private listeners = new Set<(locale: Locale) => void>();

  constructor(options: I18nOptions) {
    this.locale = options.locale;
    this.fallbackLocale = options.fallbackLocale ?? DEFAULT_LOCALE;
    this.catalog = options.catalog;
  }

  get currentLocale(): Locale {
    return this.locale;
  }

  setLocale(locale: Locale): void {
    if (locale === this.locale) return;
    this.locale = locale;
    for (const listener of this.listeners) listener(locale);
  }

  onChange(listener: (locale: Locale) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 翻译：当前 locale → fallback → key 自身，三级回退消除「缺 key 崩溃」特殊情况。 */
  t(key: string, params?: TranslateParams): string {
    const template =
      this.catalog[this.locale]?.[key] ??
      this.catalog[this.fallbackLocale]?.[key] ??
      key;
    return interpolate(template, params);
  }

  /** 合并补充某 locale 的 messages（各端按需注册自己的命名空间）。 */
  extend(locale: Locale, messages: Messages): void {
    this.catalog[locale] = { ...(this.catalog[locale] ?? {}), ...messages };
  }
}

/** 工厂：缺省 zh-CN。 */
export function createI18n(options: Partial<I18nOptions> & { catalog: LocaleCatalog }): I18n {
  return new I18n({
    locale: options.locale ?? DEFAULT_LOCALE,
    fallbackLocale: options.fallbackLocale ?? DEFAULT_LOCALE,
    catalog: options.catalog,
  });
}

/** 共享层基础 messages（错误/通用 UI）；各端 extend 自己的业务文案。 */
export const sharedMessages: LocaleCatalog = {
  "zh-CN": {
    "common.loading": "加载中…",
    "common.retry": "重试",
    "common.cancel": "取消",
    "common.confirm": "确定",
    "error.network": "网络异常，请检查连接后重试",
    "error.unauthorized": "登录已失效，请重新登录",
    "error.forbidden": "无权访问",
    "error.not_found": "资源不存在",
    "error.conflict": "操作冲突，请刷新后重试",
    "error.unknown": "操作失败，请稍后重试",
    "error.validation": "输入校验失败，请检查后重试",
  },
};
