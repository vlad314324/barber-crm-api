const CURRENCY_SYMBOLS = { UAH: 'грн', CZK: 'Kč', EUR: '€', PLN: 'zł', USD: '$', GBP: '£' };

function currencySymbol(code) {
  return CURRENCY_SYMBOLS[code] || CURRENCY_SYMBOLS.UAH;
}

module.exports = { currencySymbol };
