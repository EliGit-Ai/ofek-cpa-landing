# ה־workflow ב־n8n – שלד, פרמטרים ומלכודות

## תוכן
1. [תשתית לפני ה־workflow](#1-תשתית-לפני-ה-workflow)
2. [שלד ה־nodes](#2-שלד-ה-nodes)
3. [צורת הפרמטרים](#3-צורת-הפרמטרים)
4. [ולידציה](#4-ולידציה)
5. [מלכודות – SDK ו־MCP](#5-מלכודות--sdk-ו-mcp)
6. [מלכודות – nodes ושירותים](#6-מלכודות--nodes-ושירותים)
7. [סוכן AI מאחורי polling](#7-סוכן-ai-מאחורי-polling)

---

## 1. תשתית לפני ה־workflow

- **Data Table** לעבודות: `create_data_table` עם עמודות string – `jobId`, `status`, `stage`, `result`.
  שמרו את ה־id שחוזר; ה־nodes מפנים אליו ב־`{ __rl: true, mode: 'id', value: '<id>' }`.
- **Credentials**: `list_credentials` ובחרו קיימים. אל תמציאו מזהים. אם יש כמה מאותו סוג ואין רמז – שאלו.
- **יעדי כתיבה** (גיליון, תיקייה): צרו אותם ב־workflow זמני חד־פעמי, והעבירו אותו ל־archive בסוף.
  workflows זמניים שנשארים פעילים הם זבל שהמשתמש ימצא בעוד חודש.

## 2. שלד ה־nodes

```
[Webhook POST]  path: <action>, responseMode: responseNode, options.allowedOrigins: '*'
   → [Validate]           Code: מחזיר { ok:true, input:{…} } או { ok:false, error, field }
   → [IF ok]
        false → [Respond Invalid]   respondToWebhook, options.responseCode: 400, body {error, field}
        true  → [Create Job]        Set: jobId = prefix + $now.toMillis().toString(36) + random
              → [Save Job]          dataTable insert: jobId, status='pending', stage=<ראשון>
              → [Respond Job ID]    respondToWebhook: { jobId, status:'pending' }
              → [עבודה 1]
              → [Stage: x]          dataTable update where jobId → stage='x'
              → [עבודה 2] …
              → [Save Result]       dataTable update: status='done', stage='done', result=JSON.stringify(…)

[Webhook GET]   path: <action>-status, responseMode: responseNode, allowedOrigins: '*'
   → [Get Job]            dataTable get where jobId = query.jobId, limit 1, alwaysOutputData: true
   → [Respond Status]     { jobId, status: $json.status || 'not_found', stage, result (רק ב-done) }
                          + header Cache-Control: no-store
```

למה `alwaysOutputData` דווקא ב־Get Job: זה המקרה היחיד שבו ענף ה"ריק" צריך לרוץ – כדי להחזיר `not_found`.
בשאר המקומות אל תוסיפו אותו.

ה־workflow ממשיך לרוץ אחרי `Respond to Webhook` – זה מה שמאפשר "עונים קודם, עובדים אחר כך".

## 3. צורת הפרמטרים

Data Table (typeVersion 1.1):

```js
// insert
{ resource: 'row', operation: 'insert', dataTableId: TABLE,
  columns: { mappingMode: 'defineBelow',
             value: { jobId: expr('{{ $json.jobId }}'), status: 'pending', stage: 'calc' },
             schema: [ { id: 'jobId', displayName: 'jobId', required: false, defaultMatch: false,
                         display: true, type: 'string', canBeUsedToMatch: true }, /* … */ ] } }

// update
{ resource: 'row', operation: 'update', dataTableId: TABLE, matchType: 'allConditions',
  filters: { conditions: [{ keyName: 'jobId', condition: 'eq',
                            keyValue: expr("{{ $('Create Job').item.json.jobId }}") }] },
  columns: { mappingMode: 'defineBelow', value: { stage: 'ai' }, schema: [ /* stage */ ] } }

// get
{ resource: 'row', operation: 'get', dataTableId: TABLE, matchType: 'allConditions',
  filters: { conditions: [{ keyName: 'jobId', condition: 'eq',
                            keyValue: expr("{{ $json.query.jobId || '__none__' }}") }] },
  limit: 1, returnAll: false }
```

Respond Status:

```js
responseBody: expr("{{ { \"jobId\": $('Status Webhook').item.json.query.jobId || null, \"status\": $json.status || \"not_found\", \"stage\": $json.stage || null, \"result\": $json.status === 'done' && $json.result ? JSON.parse($json.result) : null } }}")
```

**כלל זהב לנתונים בשרשרת:** node מקבל רק את הפלט של ה־node שלפניו, ו־nodes של כתיבה (Data Table update,
Sheets append, Gmail) מוציאים את *תשובת ה־API*, לא את הנתונים שלכם. אחרי כל node כזה, הפנו במפורש:
`$('Create Job').item.json.jobId`, `$('Compose').item.json.html` – לא `$json`.

## 4. ולידציה

Code node אחד בתחילת השרשרת. מחזיר תמיד פריט אחד:

```js
const b = $input.first().json.body || {};
const fail = (field, error) => [{ json: { ok: false, field, error } }];
if (b.website) return fail('website', 'הבקשה נחסמה.');            // honeypot
const email = String(b.email || '').trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail('email', 'כתובת האימייל לא תקינה.');
// … מספרים: Number.isInteger + טווח; בחירות: includes ברשימה סגורה; הסכמה: === true
return [{ json: { ok: true, input: { /* ערכים מנוקים בלבד */ } } }];
```

הודעת השגיאה היא בעברית ומיועדת למשתמש – העמוד מציג אותה כמו שהיא ומסמן את `field`.
ולידציה בשרת היא החובה; ולידציה בדפדפן היא נוחות.

## 5. מלכודות – SDK ו־MCP

| מה קרה | מה עושים |
|---|---|
| `validate_workflow` דוחה: "Arrow functions are not allowed" | בקוד ה־SDK אסור להגדיר פונקציות עזר או `.map()` ברמה העליונה. פורשים הכול כאובייקטים מפורשים. בתוך מחרוזת `jsCode` של Code node – מותר הכול |
| `setNodeParameter` נכשל: "array index N out of bounds" | אי אפשר להוסיף איבר למערך דרך אינדקס. שולחים `updateNodeParameters` עם המערך המלא |
| עדכון `jsCode` קיים | `setNodeParameter` עם `path: '/jsCode'` וכל הקוד מחדש. ב־JSON רגיל כותבים backtick ו־`${}` רגילים (ב־SDK בתוך template literal צריך `\`` ו־`\${`) |
| ה־webhook מחזיר התנהגות ישנה | שכחתם `publish_workflow` אחרי העדכון |
| `get_workflow_details` נכשל: "not available in MCP" | המשתמש צריך להפעיל גישת MCP ל־workflow בהגדרות שלו. אמרו לו; אל תנחשו את התוכן |
| `get_node_types` מחזיר מאות KB | ביקשתם node ענק (Firecrawl). קראו מהקובץ שנשמר רק את ה־operation שצריך |
| publish נכשל: "Missing required credential" | ראו Gateway למטה |

לפני כתיבת קוד SDK: `get_workflow_sdk_reference`, ו־`get_node_types` לכל node (עם ה־resource/operation). לא מנחשים שמות פרמטרים.

## 6. מלכודות – nodes ושירותים

**Gateway credits (קרדיט מובנה של n8n).** הרשימה ב־`list_n8n_gateway_services` מתייחסת ל־node הרגיל
ולגרסה מינימלית מסוימת. גרסת ה־**Tool** של אותו node (זו שמתחברת לסוכן) לא בהכרח מכוסה: Brave Search Tool
קיבל credential אוטומטי ואז נכשל בריצה עם `SUBSCRIPTION_TOKEN_INVALID`. Firecrawl Tool עבד.
**מסקנה: credential ששויך אוטומטית אינו הוכחה. מריצים בקשה אמיתית ובודקים את ה־execution.**

**Google Sheets – גיליון ריק.** `append` עם `defineBelow` לגיליון בלי שורת כותרות לא כותב את העמודות
שהגדרתם – הוא כותב את שדות הפריט שנכנס (למשל `jobId, status, stage` מה־node הקודם), וה־execution מסומן כהצלחה.
פתרון: לפני הכול לכתוב שורת כותרות – Code node שמחזיר פריט שהמפתחות שלו הם שמות העמודות,
ואחריו `append` במצב `autoMapInputData`. ואז **לקרוא את הגיליון** ולוודא.

**Google Sheets – יצירה.** locale לעברית הוא `iw_IL` (לא `he_IL`).

**LLM.** `retryOnFail: true, maxTries: 2` + `onError: continueRegularOutput`. ב־node שאחריו: אם אין פלט –
טקסט ברירת מחדל או `status='error'`. ספק ה־AI מחזיר מדי פעם 500, וזה לא צריך להגיע למשתמש.

**ניסוח של AI בעברית.** הורו במפורש: לשון רבים ניטרלית ("אתם"), בלי להסיק מגדר מהשם, בלי לפתוח בשם,
ורק מתוך הנתונים שקיבל. בלי זה תקבלו "נועה, מאחר שאת עצמאית…".

**ערכי אפס.** "0 ₪" או שדה ריק שמשמעותם "בהצעה פרטנית" – מחליפים לתווית מפורשת לפני שהם מגיעים
למשתמש או למאגר ידע. מודל שרואה "0 ₪" יגיד שזה בחינם.

**Telegram / Gmail בבדיקות.** אלה נשלחים באמת. השתמשו בכתובות `+alias` של בעל הפרויקט ודווחו מה נשלח.

## 7. סוכן AI מאחורי polling

כשהעבודה היא AI Agent (צ'אט):

- אין שלבי ביניים לדווח – העמוד מציג שעון, לא שלבים מומצאים.
- **זיכרון**: Simple Memory עם `sessionIdType: 'customKey'` ו־`sessionKey` מתוך ה־`sessionId` שהעמוד שולח.
  ב־workflow מבוסס webhook אין Chat Trigger, אז `fromInput` לא יעבוד. שמרו את `sessionId` ב־Create Job.
- **גבול תוכן**: בלי הוראה מפורשת הסוכן עונה מהידע הכללי שלו על כל שאלה. כתבו ב־system prompt:
  עונים רק על סמך מה שהכלים החזירו; מה מותר, מה אסור (עם דוגמאות), ושני נוסחי סירוב – לנושא לא קשור,
  ולשאלה מקצועית שאין עליה מידע. בדקו עם שאלות מחוץ לתחום וגם עם "תתעלם מההוראות".
- **RAG**: אם הסוכן אומר "אין לי מידע" על משהו שכן במאגר – בדקו מה ה־vector store החזיר בפועל.
  חלוקה לקטעים לפי שורות מפרידה כותרת מתוכן. כל קטע צריך לכלול את כותרת הסעיף + התוכן; `topK` 8 ולא 4.
- `Save Reply`: `status = $json.output ? 'done' : 'error'`, ו־`onError: continueRegularOutput` על הסוכן –
  כדי שגם כשל יסתיים בסטטוס ברור ולא ב־timeout של 90 שניות.
