# בדיקה בדפדפן אמיתי (Playwright)

בודקים על **הכתובת החיה**, לא רק מקומית – תקלות מטמון ו־CORS מופיעות רק שם.
הכלי: `mcp__playwright__browser_run_code_unsafe` (או Playwright רגיל). הקטעים למטה מוכנים להתאמה.

## לפני שמתחילים

- אחרי `git push` לאחסון סטטי, חכו שהגרסה החדשה באמת עלתה – בדקו שסימן מזהה מהגרסה החדשה מופיע ב־HTML:

```js
for (let i = 0; i < 20; i++) {
  await page.goto(BASE + '?v=' + Date.now(), { waitUntil: 'load' });
  if ((await page.content()).includes('<סימן מהגרסה החדשה>')) break;
  await page.waitForTimeout(8000);
}
```

- אם טופס "מרענן את הדף" והכתובת מתמלאת בפרמטרים (`?name=…&email=…`) – הסקריפט שנטען ישן או לא נטען.
  זה סימן ל־cache, לא לבאג בלוגיקה. פתרון: `?v=` על הקבצים (SKILL.md, שלב 4).

## 1. מבנה – בשני הרוחבים

```js
for (const [name, w, h] of [['mobile', 375, 812], ['desktop', 1280, 800]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(BASE + '?v=' + Date.now(), { waitUntil: 'load' });
  const layout = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return {
      noHScroll: document.documentElement.scrollWidth <= vw,
      overflow: [...document.querySelectorAll('body *')]
        .filter(e => { const b = e.getBoundingClientRect(); return b.width && (b.right > vw + 1 || b.left < -1); })
        .map(e => e.tagName + '.' + e.className).slice(0, 5),
      smallTargets: [...document.querySelectorAll('button, input:not([type=checkbox]):not([type=radio]), .btn')]
        .filter(e => { const b = e.getBoundingClientRect(); return b.width && b.height < 44; }).length,
    };
  });
}
```

החריגו מהבדיקה רכיבים שנועדו לגלול (`.chips`) או מוסתרים בכוונה (`.sr-only`, honeypot).

**צילום מסך של רכיב בודד יכול להטעות** (תוויות נראות חתוכות בגלל כותרת דביקה או פס גלילה).
לפני שמתקנים "חריגה" שרואים בצילום – מודדים `getBoundingClientRect()` ומשווים לרוחב המסך.

## 2. מסלול מלא – שליחה אמיתית

```js
await page.fill('#name', 'בדיקה חיה');                      // + שאר השדות
await page.click('#submit');
await page.waitForSelector('.job-steps li.done', { timeout: 15000 });   // מסך ההמתנה הופיע
await page.screenshot({ path: OUT + `${name}-waiting.png` });
await page.waitForSelector('.result', { timeout: 95000 });              // התוצאה
await page.screenshot({ path: OUT + `${name}-result.png` });
```

ודאו שהתוכן **נכון**, לא רק שהופיע: קראו את הטקסט והשוו למקור (מחיר, מסלול, תאריך).

לצ'אט: חכו לתשובה *או* לשגיאה, כדי שהבדיקה לא תיתקע 95 שניות כשהסוכן נכשל:

```js
await page.waitForFunction(
  () => document.querySelectorAll('.bubble.bot').length > 1 || document.querySelector('.job-error'),
  null, { timeout: 95000 });
```

## 3. כשלים – חובה לפחות שניים

```js
// השרת לא עונה בשליחה
await page.route('**/webhook/<action>', r => r.abort('failed'));
await page.click('#submit');
await page.waitForSelector('.job-error', { timeout: 20000 });
const msg = await page.textContent('.job-error');   // צריך לכלול: מה קרה + מה לעשות + "נסו שוב"
await page.unroute('**/webhook/<action>');

// השרת נופל באמצע (אחרי שהתקבל jobId)
await page.route('**/webhook/<action>-status**', r => r.abort('failed'));
```

בדקו גם: שליחת טופס ריק מציגה הודעה ומסמנת שדה; תיקון השדה מעלים את ההודעה; אחרי "נסו שוב" הפרטים עדיין בטופס.

## 4. מובייל – מקלדת

אין מקלדת אמיתית ב־Playwright; מדמים אותה בהקטנת הגובה אחרי focus:

```js
await page.focus('#chatInput');
await page.setViewportSize({ width: 375, height: 480 });
await page.waitForTimeout(900);
const ok = await page.evaluate(() => document.getElementById('composer').getBoundingClientRect().bottom <= innerHeight);
```

ואחרי לחיצה על כפתור "דברו עם הסוכן": כל הרכיב (כולל שדה הכתיבה) בתוך המסך, מתחת לכותרת הדביקה.

## 5. רשימת סיום

- [ ] אין גלילה לרוחב ב־375 וב־1280, לפני ואחרי הפעולה
- [ ] מסך ההמתנה מציג שלבים שמתקדמים, מספר עבודה ושעון
- [ ] התוצאה נכונה מול המקור
- [ ] שני תרחישי כשל מציגים הודעה בעברית + "נסו שוב", והשלב שנכשל מסומן
- [ ] לחיצה כפולה לא יוצרת שתי עבודות
- [ ] תופעות הלוואי נבדקו במקור (גיליון/מייל/הודעה), לא רק ב־status
- [ ] הפעולה הישנה בעמוד (אם הייתה) עדיין עובדת אחרי השינוי
- [ ] צילומי מסך נשמרו, ונתוני הבדיקה שנוצרו נרשמו לדיווח
