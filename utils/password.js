// Єдине правило складності пароля для всіх шляхів, де він встановлюється:
// реєстрація співробітника (адміном), staff-reset, forgot/reset-password,
// self-service зміна пароля. Мінімум 8 символів + хоча б одна літера й одна
// цифра — свідомо без вимоги спецсимволів/великих літер, щоб не дратувати
// персонал салону зайвою суворістю без менеджера паролів.
const PASSWORD_MIN_LENGTH = 8;

// Повертає { code, msg } при провалі, або null, якщо пароль прийнятний.
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return { code: 'PASSWORD_TOO_SHORT', msg: `Пароль має бути не менше ${PASSWORD_MIN_LENGTH} символів` };
  }
  if (!/[a-zA-Zа-яА-ЯіІїЇєЄ]/.test(password) || !/[0-9]/.test(password)) {
    return { code: 'PASSWORD_TOO_WEAK', msg: 'Пароль має містити хоча б одну літеру і одну цифру' };
  }
  return null;
}

module.exports = { PASSWORD_MIN_LENGTH, validatePassword };
