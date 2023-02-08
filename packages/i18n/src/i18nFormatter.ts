import {
  formatDate,
  isFutureDate,
  isLessThanOneHourAgo,
  isLessThanOneMinuteAgo,
  isLessThanOneWeekAgo,
  isLessThanOneYearAgo,
  isToday,
  isTomorrow,
  isYesterday,
  TimeUnit,
  isLessThanOneWeekAway,
  isLessThanOneYearAway,
} from '@shopify/dates';
import {memoize} from '@shopify/decorators';

import {
  convertFirstSpaceToNonBreakingSpace,
  getCurrencySymbol,
} from './utilities';
import {
  MissingCountryError,
  MissingCurrencyCodeError,
} from './utilities/errors';
import {translate, memoizedNumberFormatter} from './utilities/translate';
import {languageFromLocale, regionFromLocale} from './locale';
import {
  LanguageDirection,
  TranslationDictionary,
  FormatterConfig,
} from './utilities/types';
import {
  dateStyle,
  DateStyle,
  DEFAULT_WEEK_START_DAY,
  WEEK_START_DAYS,
  RTL_LANGUAGES,
  Weekday,
  currencyDecimalPlaces,
  DEFAULT_DECIMAL_PLACES,
  DIRECTION_CONTROL_CHARACTERS,
  EASTERN_NAME_ORDER_FORMATTERS,
  CurrencyShortFormException,
} from './constants';

export interface NumberFormatOptions extends Intl.NumberFormatOptions {
  as?: 'number' | 'currency' | 'percent';
  precision?: number;
}
export interface CurrencyFormatOptions extends NumberFormatOptions {
  form?: 'auto' | 'short' | 'explicit' | 'none';
}

// Used for currencies that don't use fractional units (eg. JPY)
const PERIOD = '.';
const NEGATIVE_SIGN = '-';
const REGEX_DIGITS = /\d/g;
const REGEX_NON_DIGITS = /\D/g;
const REGEX_PERIODS = /\./g;
const NEGATIVE_CHARACTERS = '\\p{Pd}\u2212';

export class I18nFormatter {
  readonly locale: string;
  readonly translations: TranslationDictionary[];
  readonly defaultCountry?: string;
  readonly defaultCurrency?: string;
  readonly defaultTimezone?: string;

  get language() {
    return languageFromLocale(this.locale);
  }

  get region() {
    return regionFromLocale(this.locale);
  }

  constructor(
    {locale, currency, timezone, country}: FormatterConfig,
    translations: TranslationDictionary[] = [],
  ) {
    this.translations = translations;
    this.locale = locale;
    this.defaultCurrency = currency;
    this.defaultCountry = country;
    this.defaultTimezone = timezone;
  }

  get languageDirection() {
    return RTL_LANGUAGES.includes(this.language)
      ? LanguageDirection.Rtl
      : LanguageDirection.Ltr;
  }

  get isRtlLanguage() {
    return this.languageDirection === LanguageDirection.Rtl;
  }

  get isLtrLanguage() {
    return this.languageDirection === LanguageDirection.Ltr;
  }

  formatNumber(
    amount: number,
    {as, precision, ...options}: NumberFormatOptions = {},
  ) {
    const {locale, defaultCurrency: currency} = this;

    if (as === 'currency' && currency == null && options.currency == null) {
      throw new MissingCurrencyCodeError(
        `formatNumber(amount, {as: 'currency'}) cannot be called without a currency code.`,
      );
    }

    return memoizedNumberFormatter(locale, {
      style: as,
      maximumFractionDigits: precision,
      currency,
      ...options,
    }).format(amount);
  }

  unformatNumber(input: string): string {
    const {decimalSymbol} = this.numberSymbols();

    const normalizedValue = this.normalizedNumber(input, decimalSymbol);

    return normalizedValue === '' ? '' : parseFloat(normalizedValue).toString();
  }

  formatCurrency(
    amount: number,
    {form, ...options}: CurrencyFormatOptions = {},
  ) {
    switch (form) {
      case 'auto':
        return this.formatCurrencyAuto(amount, options);
      case 'explicit':
        return this.formatCurrencyExplicit(amount, options);
      case 'short':
        return this.formatCurrencyShort(amount, options);
      case 'none':
        return this.formatCurrencyNone(amount, options);
      default:
        return this.formatCurrencyAuto(amount, options);
    }
  }

  unformatCurrency(input: string, currencyCode: string): string {
    const {decimalSymbol} = this.numberSymbols();
    const decimalPlaces = currencyDecimalPlaces.get(currencyCode.toUpperCase());

    const normalizedValue = this.normalizedNumber(
      input,
      decimalSymbol,
      decimalPlaces,
    );

    if (normalizedValue === '') {
      return '';
    }

    if (decimalPlaces === 0) {
      const roundedAmount = parseFloat(normalizedValue).toFixed(0);
      return `${roundedAmount}.${'0'.repeat(DEFAULT_DECIMAL_PLACES)}`;
    }

    return parseFloat(normalizedValue).toFixed(decimalPlaces);
  }

  formatPercentage(amount: number, options: Intl.NumberFormatOptions = {}) {
    return this.formatNumber(amount, {as: 'percent', ...options});
  }

  formatDate(
    date: Date,
    options: Intl.DateTimeFormatOptions & {style?: DateStyle} = {},
  ): string {
    const {locale, defaultTimezone} = this;
    const {timeZone = defaultTimezone} = options;

    const {style = undefined, ...formatOptions} = options || {};

    if (style) {
      switch (style) {
        case DateStyle.Humanize:
          return this.humanizeDate(date, {...formatOptions, timeZone});
        case DateStyle.DateTime:
          return this.formatDateTime(date, {
            ...formatOptions,
            timeZone,
            ...dateStyle[style],
          });
        default:
          return this.formatDate(date, {...formatOptions, ...dateStyle[style]});
      }
    }

    return formatDate(date, locale, {...formatOptions, timeZone});
  }

  weekStartDay(argCountry?: string): Weekday {
    const country = argCountry || this.defaultCountry;

    if (!country) {
      throw new MissingCountryError(
        'weekStartDay() cannot be called without a country code.',
      );
    }

    return WEEK_START_DAYS.get(country) || DEFAULT_WEEK_START_DAY;
  }

  getCurrencySymbol = (currencyCode?: string, locale: string = this.locale) => {
    const currency = currencyCode || this.defaultCurrency;
    if (currency == null) {
      throw new MissingCurrencyCodeError(
        'formatCurrency cannot be called without a currency code.',
      );
    }
    return this.getShortCurrencySymbol(currency, locale);
  };

  formatName(
    firstName?: string,
    lastName?: string,
    options?: {full?: boolean},
  ) {
    if (!firstName) {
      return lastName || '';
    }
    if (!lastName) {
      return firstName;
    }

    const isFullName = Boolean(options && options.full);

    const customNameFormatter =
      EASTERN_NAME_ORDER_FORMATTERS.get(this.locale) ||
      EASTERN_NAME_ORDER_FORMATTERS.get(this.language);

    if (customNameFormatter) {
      return customNameFormatter(firstName, lastName, isFullName);
    }
    if (isFullName) {
      return `${firstName} ${lastName}`;
    }
    return firstName;
  }

  hasEasternNameOrderFormatter() {
    const easternNameOrderFormatter =
      EASTERN_NAME_ORDER_FORMATTERS.get(this.locale) ||
      EASTERN_NAME_ORDER_FORMATTERS.get(this.language);
    return Boolean(easternNameOrderFormatter);
  }

  @memoize()
  numberSymbols() {
    const formattedNumber = this.formatNumber(123456.7, {
      maximumFractionDigits: 1,
      minimumFractionDigits: 1,
    });
    let thousandSymbol;
    let decimalSymbol;
    for (const char of formattedNumber) {
      if (isNaN(parseInt(char, 10))) {
        if (thousandSymbol) decimalSymbol = char;
        else thousandSymbol = char;
      }
    }
    return {thousandSymbol, decimalSymbol};
  }

  private formatCurrencyAuto(
    amount: number,
    options: Intl.NumberFormatOptions = {},
  ): string {
    // use the short format if we can't determine a currency match, or if the
    // currencies match, use explicit when the currencies definitively do not
    // match.
    const formatShort =
      options.currency == null ||
      this.defaultCurrency == null ||
      options.currency === this.defaultCurrency;

    return formatShort
      ? this.formatCurrencyShort(amount, options)
      : this.formatCurrencyExplicit(amount, options);
  }

  private formatCurrencyExplicit(
    amount: number,
    options: Intl.NumberFormatOptions = {},
  ): string {
    const value = this.formatCurrencyShort(amount, options);
    const isoCode = options.currency || this.defaultCurrency || '';
    if (value.includes(isoCode)) {
      return value;
    }
    return `${value} ${isoCode}`;
  }

  private formatCurrencyShort(
    amount: number,
    options: NumberFormatOptions = {},
  ): string {
    const formattedAmount = this.formatCurrencyNone(amount, options);
    const negativeRegex = new RegExp(
      `[${DIRECTION_CONTROL_CHARACTERS}]*[${NEGATIVE_CHARACTERS}]`,
      'gu',
    );
    const negativeMatch = negativeRegex.exec(formattedAmount)?.shift() || '';

    const shortSymbol = this.getShortCurrencySymbol(options.currency);
    const formattedWithSymbol = shortSymbol.prefixed
      ? `${shortSymbol.symbol}${formattedAmount}`
      : `${formattedAmount}${shortSymbol.symbol}`;

    return `${negativeMatch}${formattedWithSymbol.replace(negativeMatch, '')}`;
  }

  private formatCurrencyNone(
    amount: number,
    options: NumberFormatOptions = {},
  ): string {
    const {locale} = this;
    let adjustedPrecision = options.precision;
    if (adjustedPrecision === undefined) {
      const currency = options.currency || this.defaultCurrency || '';
      adjustedPrecision = currencyDecimalPlaces.get(currency.toUpperCase());
    }

    return memoizedNumberFormatter(locale, {
      style: 'decimal',
      minimumFractionDigits: adjustedPrecision,
      maximumFractionDigits: adjustedPrecision,
      ...options,
    }).format(amount);
  }

  // Intl.NumberFormat sometimes annotates the "currency symbol" with a country code.
  // For example, in locale 'fr-FR', 'USD' is given the "symbol" of " $US".
  // This method strips out the country-code annotation, if there is one.
  // (So, for 'fr-FR' and 'USD', the return value would be " $").
  //
  // For other currencies, e.g. CHF and OMR, the "symbol" is the ISO currency code.
  // In those cases, we return the full currency code without stripping the country.
  private getShortCurrencySymbol(
    currency: string = this.defaultCurrency || '',
    locale: string = this.locale,
  ) {
    const regionCode = currency.substring(0, 2);
    let shortSymbolResult: {symbol: string; prefixed: boolean};

    // currencyDisplay: 'narrowSymbol' was added to iOS in v14.5. See https://caniuse.com/?search=currencydisplay
    // We still support ios 12/13, so we need to check if this works and fallback to the default if not
    // All other supported browsers understand narrowSymbol, so once our minimum iOS version is updated we can remove this fallback
    try {
      shortSymbolResult = getCurrencySymbol(locale, {
        currency,
        currencyDisplay: 'narrowSymbol',
      });
    } catch {
      shortSymbolResult = getCurrencySymbol(locale, {currency});
    }

    if (currency in CurrencyShortFormException) {
      return {
        symbol: CurrencyShortFormException[currency],
        prefixed: shortSymbolResult.prefixed,
      };
    }

    const shortSymbol = shortSymbolResult.symbol.replace(regionCode, '');
    const alphabeticCharacters = /[A-Za-zÀ-ÖØ-öø-ÿĀ-ɏḂ-ỳ]/;

    return alphabeticCharacters.exec(shortSymbol)
      ? shortSymbolResult
      : {symbol: shortSymbol, prefixed: shortSymbolResult.prefixed};
  }

  private humanizeDate(date: Date, options?: Intl.DateTimeFormatOptions) {
    return isFutureDate(date)
      ? this.humanizeFutureDate(date, options)
      : this.humanizePastDate(date, options);
  }

  private formatDateTime(
    date: Date,
    options: Intl.DateTimeFormatOptions,
  ): string {
    const {defaultTimezone} = this;
    const {timeZone = defaultTimezone} = options;

    return translate(
      'date.humanize.lessThanOneYearAway',
      this.translations,
      this.locale,
      {
        date: this.getDateFromDate(date, {
          ...options,
          timeZone,
        }),
        time: this.getTimeFromDate(date, {
          ...options,
          timeZone,
        }),
      },
    );
  }

  private humanizePastDate(date: Date, options?: Intl.DateTimeFormatOptions) {
    if (isLessThanOneMinuteAgo(date)) {
      return translate(
        'date.humanize.lessThanOneMinuteAgo',
        this.translations,
        this.locale,
      );
    }

    if (isLessThanOneHourAgo(date)) {
      const now = new Date();
      const minutes = Math.floor(
        (now.getTime() - date.getTime()) / TimeUnit.Minute,
      );
      return translate(
        'date.humanize.lessThanOneHourAgo',
        this.translations,
        this.locale,
        {
          count: minutes,
        },
      );
    }

    const timeZone = options?.timeZone;
    const time = this.getTimeFromDate(date, options);

    if (isToday(date, timeZone)) {
      return time;
    }

    if (isYesterday(date, timeZone)) {
      return translate(
        'date.humanize.yesterday',
        this.translations,
        this.locale,
        {time},
      );
    }

    if (isLessThanOneWeekAgo(date)) {
      const weekday = this.getWeekdayFromDate(date, options);
      return translate(
        'date.humanize.lessThanOneWeekAgo',
        this.translations,
        this.locale,
        {
          weekday,
          time,
        },
      );
    }

    if (isLessThanOneYearAgo(date)) {
      const monthDay = this.getMonthDayFromDate(date, options);
      return translate(
        'date.humanize.lessThanOneYearAgo',
        this.translations,
        this.locale,
        {
          date: monthDay,
          time,
        },
      );
    }

    return this.formatDate(date, {
      ...options,
      style: DateStyle.Short,
    });
  }

  private humanizeFutureDate(date: Date, options?: Intl.DateTimeFormatOptions) {
    const timeZone = options?.timeZone;
    const time = this.getTimeFromDate(date, options);

    if (isToday(date, timeZone)) {
      return translate('date.humanize.today', this.translations, this.locale, {
        time,
      });
    }

    if (isTomorrow(date, timeZone)) {
      return translate(
        'date.humanize.tomorrow',
        this.translations,
        this.locale,
        {time},
      );
    }

    if (isLessThanOneWeekAway(date)) {
      const weekday = this.getWeekdayFromDate(date, options);
      return translate(
        'date.humanize.lessThanOneWeekAway',
        this.translations,
        this.locale,
        {
          weekday,
          time,
        },
      );
    }

    if (isLessThanOneYearAway(date)) {
      const monthDay = this.getMonthDayFromDate(date, options);
      return translate(
        'date.humanize.lessThanOneYearAway',
        this.translations,
        this.locale,
        {
          date: monthDay,
          time,
        },
      );
    }

    return this.formatDate(date, {
      ...options,
      style: DateStyle.Short,
    });
  }

  private getTimeZone(
    date: Date,
    options?: Intl.DateTimeFormatOptions,
  ): string {
    const {localeMatcher, formatMatcher, timeZone} = options || {};

    const hourZone = this.formatDate(date, {
      localeMatcher,
      formatMatcher,
      timeZone,
      hour12: false,
      timeZoneName: 'short',
      hour: 'numeric',
    });

    const zoneMatchGroup = /\s([\w()+\-:.]+$)/.exec(hourZone);

    return zoneMatchGroup ? zoneMatchGroup[1] : '';
  }

  private getDateFromDate(date: Date, options?: Intl.DateTimeFormatOptions) {
    const {
      localeMatcher,
      formatMatcher,
      weekday,
      day,
      month,
      year,
      era,
      timeZone,
      timeZoneName,
    } = options || {};

    const formattedDate = this.formatDate(date, {
      localeMatcher,
      formatMatcher,
      weekday,
      day,
      month,
      year,
      era,
      timeZone,
      timeZoneName: timeZoneName === 'short' ? undefined : timeZoneName,
    });

    return formattedDate;
  }

  private getTimeFromDate(date: Date, options?: Intl.DateTimeFormatOptions) {
    const {localeMatcher, formatMatcher, hour12, timeZone, timeZoneName} =
      options || {};

    const formattedTime = this.formatDate(date, {
      localeMatcher,
      formatMatcher,
      hour12,
      timeZone,
      timeZoneName: timeZoneName === 'short' ? undefined : timeZoneName,
      hour: 'numeric',
      minute: '2-digit',
    }).toLocaleLowerCase();

    const time =
      timeZoneName === 'short'
        ? `${formattedTime} ${this.getTimeZone(date, options)}`
        : formattedTime;

    return convertFirstSpaceToNonBreakingSpace(time);
  }

  private getWeekdayFromDate(date: Date, options?: Intl.DateTimeFormatOptions) {
    const {localeMatcher, formatMatcher, hour12, timeZone} = options || {};
    return this.formatDate(date, {
      localeMatcher,
      formatMatcher,
      hour12,
      timeZone,
      weekday: 'long',
    });
  }

  private getMonthDayFromDate(
    date: Date,
    options?: Intl.DateTimeFormatOptions,
  ) {
    const {localeMatcher, formatMatcher, hour12, timeZone} = options || {};
    return this.formatDate(date, {
      localeMatcher,
      formatMatcher,
      hour12,
      timeZone,
      month: 'short',
      day: 'numeric',
    });
  }

  private normalizedNumber(
    input: string,
    decimalSymbol: string,
    decimalPlaces: number = DEFAULT_DECIMAL_PLACES,
  ) {
    const maximumDecimalPlaces = Math.max(
      decimalPlaces,
      DEFAULT_DECIMAL_PLACES,
    );
    const lastIndexOfPeriod = input.lastIndexOf(PERIOD);
    let lastIndexOfDecimal = input.lastIndexOf(decimalSymbol);

    // For locales that do not use period as the decimal symbol, users may still input a period
    // and expect it to be treated as the decimal symbol for their locale.
    if (
      decimalSymbol !== PERIOD &&
      (input.match(REGEX_PERIODS) || []).length === 1 &&
      this.decimalValue(input, lastIndexOfPeriod).length <= maximumDecimalPlaces
    ) {
      lastIndexOfDecimal = lastIndexOfPeriod;
    }

    const integerValue = this.integerValue(input, lastIndexOfDecimal);
    const decimalValue = this.decimalValue(input, lastIndexOfDecimal);

    const negativeRegex = new RegExp(
      `^[${DIRECTION_CONTROL_CHARACTERS}\\s]*[${NEGATIVE_CHARACTERS}]`,
      'u',
    );
    const negativeSign = input.match(negativeRegex) ? NEGATIVE_SIGN : '';

    const normalizedDecimal = lastIndexOfDecimal === -1 ? '' : PERIOD;
    const normalizedValue = `${negativeSign}${integerValue}${normalizedDecimal}${decimalValue}`;

    return normalizedValue.match(REGEX_DIGITS) ? normalizedValue : '';
  }

  private integerValue(input: string, lastIndexOfDecimal: number) {
    return input.substring(0, lastIndexOfDecimal).replace(REGEX_NON_DIGITS, '');
  }

  private decimalValue(input: string, lastIndexOfDecimal: number) {
    return input
      .substring(lastIndexOfDecimal + 1)
      .replace(REGEX_NON_DIGITS, '');
  }
}
