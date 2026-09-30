---
name: n8n-polling-action
description: >-
  Build a long-running action on a web page that runs in n8n and reports back by polling: the page
  sends a request, gets a job ID, asks every few seconds whether it is done, and meanwhile shows a
  waiting screen with real steps. Covers the API contract, the n8n workflow (webhooks, Data Table
  job store, real stages, validation, failure handling), the front-end (shared polling module,
  waiting card, Hebrew error messages with retry), and end-to-end verification with Playwright.
  Use this skill whenever a page, form, chat widget or button has to trigger an n8n workflow,
  AI agent or automation that takes more than a couple of seconds — even if the user only says
  "connect the form to n8n", "make the chat talk to the agent", "add a loading/waiting screen",
  "the webhook times out", or in Hebrew "פולינג", "polling", "מספר עבודה", "מסך המתנה",
  "לחבר את הטופס ל-n8n", "הסוכן לא עונה בעמוד", "אוטומציה שמופעלת מהאתר". Also use it when
  an existing page↔n8n connection is broken, hangs, or shows a fake progress animation.
---

# פעולה ארוכה בעמוד ↔ n8n בשיטת Polling

## מה בונים ולמה כך

עמוד אינטרנט שמפעיל עבודה ב־n8n (סוכן AI, אוטומציה, יצירת מדיה) לא יכול פשוט לחכות לתשובה:
בקשה שנמשכת 10–60 שניות נחתכת, והמשתמש בוהה במסך קפוא. הפתרון הוא **שלוש תנועות**:

1. העמוד שולח `POST` → n8n מחזיר **מיד** `jobId` וממשיך לעבוד ברקע.
2. העמוד שואל כל 2 שניות `GET status?jobId=…`.
3. בינתיים מוצג מסך המתנה ש**מראה מה קורה באמת**, ובסוף התוצאה או הודעת שגיאה עם "נסו שוב".

הסקיל הזה הוא התהליך המלא, מאפיון ועד בדיקה. עבדו לפי הסדר; כל שלב נשען על הקודם.

```
1. אפיון קצר      → מה הפעולה, מה נכנס, מה יוצא, אילו שלבים אמיתיים יש
2. חוזה API       → לפני שכותבים שורת קוד אחת
3. n8n            → references/n8n-workflow.md
4. צד לקוח        → assets/polling.js + assets/polling.css
5. בדיקה          → scripts/poll_test.py ואז references/verification.md (Playwright)
6. דיווח          → מה נבדק, מה לא, ומה נשאר אצל המשתמש
```

## 1. אפיון – ארבע שאלות

לפני שבונים, ודאו שיש תשובה (מהשיחה, מהקוד הקיים, או בשאלה אחת למשתמש):

- **מה הפעולה ומה היא מחזירה?** טקסט (תשובת סוכן), אובייקט (המלצה, הצעת מחיר), קובץ/כתובת.
- **מה הקלט ומה חובה בו?** זה קובע את הוולידציה.
- **אילו שלבים אמיתיים יש בצד השרת?** למשל: חישוב → AI → שמירה → מייל. אם אין שלבי ביניים
  שאפשר לדווח עליהם (סוכן AI הוא קופסה שחורה), מציגים רק: נשלח → התקבל מספר עבודה → עובד (שעון) → הסתיים.
- **אילו תופעות לוואי יש?** מייל, הודעה, שורה בגיליון, אירוע ביומן – אלה קובעים איך בודקים בלי להציף אנשים.

אם קיים כבר workflow או עמוד – קראו אותם קודם. ברוב המקרים חצי מהעבודה כבר שם, והחצי השני שבור
(למשל: השרת מחזיר `jobId` אבל העמוד מחכה ל־`output`).

## 2. חוזה ה־API

קבעו וכתבו אותו (בהערה בקוד או במסמך התכנון) לפני הבנייה – שני הצדדים נבנים מולו.

```
POST  /webhook/<action>
  body: { ...שדות הקלט }
  200 → { "jobId": "abc123", "status": "pending" }
  400 → { "error": "הודעה למשתמש בעברית", "field": "email" }

GET   /webhook/<action>-status?jobId=abc123
  200 → { "jobId", "status": "pending" | "done" | "error" | "not_found",
          "stage": "calc" | "ai" | "save" | ... | null,
          "result": <רק כש־status=done> }
```

כללים שנלמדו בדרך הקשה:

- `result` מוחזר **רק** כש־`done`. כך העמוד לא מציג תוצאה חלקית.
- `not_found` הוא סטטוס, לא שגיאת HTTP – כך העמוד יכול להסביר מה קרה.
- כשל של שלב לא־קריטי (מייל, הודעה) **לא** מפיל את העבודה: `status=done` עם דגל בתוצאה
  (`emailSent: false`), והעמוד מסביר. המשתמש קיבל את מה שביקש; חבל להציג "שגיאה".
- ערכים שחייבים להיות מדויקים (מחירים, תאריכים, חישובים) מחושבים ב**קוד**, לא ב־AI.
  ה־AI רק מנסח סביבם. מודל שממציא מחיר הוא באג שלא מוצאים בבדיקה אחת.

## 3. ה־workflow ב־n8n

קראו את `references/n8n-workflow.md` – שם שלד ה־nodes, צורת הפרמטרים של Data Table,
ורשימת המלכודות של ה־SDK וה־MCP (חלקן עולות שעה כל אחת אם לא מכירים אותן).

העיקרון: **עונים קודם, עובדים אחר כך.**

```
Webhook (POST) → Validate (Code) → IF ok?
   ├─ לא → Respond 400 {error, field}
   └─ כן → Create Job (jobId) → Data Table insert (pending, stage ראשון)
           → Respond {jobId}                      ← העמוד משתחרר כאן
           → [עבודה] → update stage → [עבודה] → update stage → …
           → Data Table update (status=done, result=JSON)

Webhook (GET status) → Data Table get (alwaysOutputData) → Respond {status, stage, result}
```

- שמרו את העבודות ב־**Data Table** של n8n (עמודות: `jobId`, `status`, `stage`, `result`). אין צורך בשירות חיצוני.
- עדכנו `stage` **לפני** כל שלב ארוך. זה מה שהופך את מסך ההמתנה מאנימציה לדיווח אמיתי.
- nodes חיצוניים (LLM, מייל, גיליון, הודעות): `onError: continueRegularOutput`, ול־LLM גם
  `retryOnFail` עם 2 ניסיונות – ספקי AI מחזירים מדי פעם שגיאת 500 חולפת.
- שני ה־webhooks צריכים `allowedOrigins: '*'` (אחרת הדפדפן חוסם), וה־status גם `Cache-Control: no-store`.
- אחרי כל שינוי: `publish`. ה־webhook של הפרודקשן מריץ את הגרסה המפורסמת, לא את הטיוטה.

## 4. צד הלקוח

העתיקו את `assets/polling.js` ו־`assets/polling.css` לפרויקט (או מזגו לקבצים הקיימים). המודול נותן:

| פונקציה | תפקיד |
|---|---|
| `startJob(url, body)` | POST, מחזיר `jobId`. זורק `JobError('invalid', {error, field})` על 400 |
| `pollJob(statusUrl, jobId, startedAt, onUpdate)` | שואל כל 2 שנ׳ עד 90 שנ׳, סובל 2 כשלים רצופים, מחזיר את הסטטוס הסופי |
| `createJobCard(container, steps)` | כרטיס המתנה: `active/done/reach(stage)/finish`, מספר עבודה, שעון שניות, `error(info, onRetry)` |
| `createRunner({...})` | חיבור מוכן לטופס: נעילה, מסך המתנה לפי `stage`, תוצאה, שגיאות ו"נסו שוב". מתחילים ממנו ומתאימים |

מה שחייב להיות נכון, ולמה:

- **שלבים אמיתיים בלבד.** אל תציגו "מנתח… מחשב… מסיים…" על טיימר. אם אין `stage` מהשרת – שעון שניות
  ומספר עבודה הם הדיווח הכן. משתמשים (ובודקים) מזהים התקדמות מזויפת.
- **הודעת שגיאה = מה קרה + מה לעשות + כפתור "נסו שוב".** הכינו טבלה לכל מצב:
  `offline`, `unreachable`, `server`, `failed`, `notFound`, `timeout`. ראו דוגמה ב־`assets/polling.js`.
- **נעילה בזמן עבודה** (כפתור disabled + דגל) – אחרת לחיצה כפולה יוצרת שתי עבודות ושני מיילים.
- **טקסט מהשרת נכנס ב־`textContent`**, לא ב־`innerHTML`. תשובת סוכן היא קלט לא מהימן.
- **טופס**: `action="javascript:void(0)"` + `novalidate` + ולידציה משלכם. אם הסקריפט לא נטען, טופס
  בלי זה נשלח כ־GET ומרענן את הדף עם כל הפרטים בכתובת.
- **Cache-busting**: `script.js?v=<timestamp>` ו־`style.css?v=…` בכל פריסה. אחסון סטטי (GitHub Pages)
  מגיש HTML חדש עם JS ישן מהמטמון, והעמוד נשבר בדיוק אחרי עדכון.
- **עברית**: `dir="auto"` על טקסט דינמי; מספר עבודה, אימייל וטלפון בתוך `<bdi dir="ltr">`;
  לא עוטפים מחיר עם ₪ ב־`<bdi>` (הסימן קופץ לצד הלא נכון).
- **מובייל**: שדות בגודל פונט 16px (אחרת iOS מגדיל את המסך), כפתורים ≥44px, והקישור "דברו עם…" מוביל
  לרכיב עצמו ולא לראש הסקשן.

## 5. בדיקה – שלוש שכבות

אל תכריזו "עובד" לפני שעברתם את שלושתן. כל אחת תפסה אצלנו באגים שהאחרות פספסו.

**א. מול השרת, בלי דפדפן** – `scripts/poll_test.py`:

```bash
python scripts/poll_test.py --start <POST url> --status <GET url> --body @case.json
python scripts/poll_test.py --start <POST url> --status <GET url> --body @bad.json --expect-status 400
```

הסקריפט שולח UTF-8 נכון, מדפיס את מעברי ה־`stage` ואת התוצאה, ומחזיר קוד יציאה 0/1.
כתבו את גוף הבקשה ל**קובץ** JSON (בקידוד UTF-8) והעבירו אותו עם `@` – ב־Windows, עברית שעוברת
כארגומנט בשורת הפקודה (וגם `curl` מתוך Git Bash) מגיעה לשרת כ־`?????`. הריצו לפחות: מקרה רגיל, מקרה קצה (מעל התקרה / ערך ריק), וקלט לא תקין (מצפים ל־400).
**בדקו את המספרים מול המקור** (מחירון, מאגר ידע) – לא רק שחזרה תשובה.

**ב. תופעות הלוואי עצמן.** קראו את הגיליון, בדקו שההודעה נשלחה, פתחו את ה־execution ב־n8n.
"הצליח" ב־n8n לא אומר שנכתב הדבר הנכון (ראו מלכודת הגיליון הריק ב־reference).

**ג. בדפדפן אמיתי, על הכתובת החיה** – `references/verification.md`: Playwright ברוחב 375 ו־1280,
שליחה אמיתית, סימולציית כשל (`page.route(...).abort()`), ובדיקה שאין גלילה לרוחב.

לבדיקות ששולחות מיילים: השתמשו בכתובת של בעל הפרויקט עם `+alias` (`name+test1@gmail.com`), וספרו
לו בסוף אילו שורות/מיילים/הודעות בדיקה נוצרו כדי שיוכל לנקות.

## 6. דיווח

סכמו למשתמש: מה נבנה, מה **נבדק בפועל** ומה התוצאות, מה **לא** נבדק (ולמה), נתוני בדיקה שנשארו,
וסיכון אחד שכדאי שיכיר: webhook ציבורי שמבצע פעולות (שולח מייל, כותב ליומן) פתוח לכל גולש.
honeypot וולידציה מצמצמים ספאם אבל אינם הגבלת קצב – אמרו את זה במפורש.

## קבצים בסקיל

- `references/n8n-workflow.md` – שלד ה־workflow, פרמטרים, ומלכודות n8n (SDK, MCP, Gateway, Sheets). לקרוא לפני שלב 3.
- `references/verification.md` – קטעי Playwright מוכנים ורשימת הבדיקות. לקרוא לפני שלב 5ג.
- `assets/polling.js`, `assets/polling.css` – מודול הלקוח. להעתיק לפרויקט בשלב 4.
- `scripts/poll_test.py` – בדיקת קצה־לקצה מהטרמינל. להריץ בשלב 5א.
