# מסמך מסירה: PWA והתראות פוש ← סשן האפליקציה הנייטיבית

נכתב על ידי הסשן שעבד על ענף `claude/youthful-brown-35wv21` (ריפו `eido300-dot/chatYemot`).
קהל היעד: הסשן שרץ על השרת ובונה את אפליקציית האנדרואיד (`android-build`, סשן "אפליקציית אנדרואיד לעדכוני GitHub").

## מה נעשה בענף הזה (שני קומיטים מעל `main`)

1. `Show message content in push notifications with quick reply`
2. `Deliver push with high urgency and re-register devices on login`

### שינויים לפי קובץ

| קובץ | שינוי |
|---|---|
| `src/worker.js` | `notify()` טוען את ההודעה ואת שם השולח; ה־payload מכיל `title` (שם השולח), `body` (טקסט, עד 140 תווים; בהודעה קולית: התמלול או "הודעה קולית"), `id`, `reply: true`. השולח עצמו לא מקבל התראה (`s.user_id === m.user_id` מדולג). נשלח עם `urgency: "high"`. |
| `src/config.js` | `push.showContent` מ־`PUSH_SHOW_CONTENT` (ברירת מחדל true; `false` = התראה כללית בלי תוכן ובלי `reply`). |
| `public/sw.js` | נכתב מחדש: כפתור פעולה "השב" מסוג `text` (תגובה מתוך ההתראה בכרום אנדרואיד). שליחה: `GET /api/me` לקבלת `csrf`, ואז `POST /api/messages` עם `{body, parentId}`. אם אין תמיכה בשדה הקלדה, הלחיצה פותחת את האתר עם `?reply=<id>`. כשל שליחה מציג התראה "התגובה לא נשלחה". |
| `public/app.js` | `subscribePush()` מופרד; הרשמה אוטומטית אחרי כניסה אם ההרשאה כבר ניתנה; טיפול ב־`?reply=<id>` ובהודעת `reply-to` מה־Service Worker. |
| `.env.example`, `docs/integrations.md` | תיעוד `PUSH_SHOW_CONTENT` והתנהגות ההתראה. |

## מה האפליקציה הנייטיבית יכולה להשתמש בו

- **פורמט ההתראה** (JSON): `{ title, body, id, reply }`. אותם שדות כדאי להציג גם בהתראה הנייטיבית.
- **API לתגובה:** `GET /api/me` מחזיר `{user, csrf}`; כל בקשה שאינה GET דורשת כותרת `X-CSRF-Token`. תגובה: `POST /api/messages` עם `{ body, parentId }`. מוגבל ל־20 הודעות בדקה.
- **שליח לא מקבל התראה על הודעה של עצמו:** לשמור על ההתנהגות הזו גם בנתיב FCM.

## ⚠️ ההבדל החשוב: Web Push מול FCM נייטיבי

הטבלה `push_subscriptions` מחזיקה רק הרשמות **Web Push** (VAPID), והשרת מאשר רק את המארחים `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com` (`validSubscription` ב־`src/security.js`).
טוקן FCM של אפליקציה נייטיבית הוא דבר אחר, ולכן:

- צריך טבלה או עמודה נפרדת לטוקני FCM, ונתיב רישום משלו (למשל `POST /api/fcm`).
- `notify()` ב־`src/worker.js` צריך לשלוח בשני הנתיבים: Web Push כמו היום, ו־FCM (HTTP v1 עם חשבון שירות) לטוקנים הנייטיבים. לשלוח עם עדיפות `high` ו־`notification` או `data` מתאימים, ולדלג על השולח.
- אין להעלות ל־GitHub את קובץ חשבון השירות של Firebase; הוא נשאר בשרת בלבד.

## קונפליקטים צפויים במיזוג

הסשן בשרת דיווח על שינויי FCM לא שמורים ב־working tree. הקבצים שנוגעים בשני הצדדים, וסביר שיתנגשו:

- `src/worker.js` (`notify`)
- `src/config.js`
- `src/app.js` (אם נוסף נתיב רישום FCM)
- `src/schema.sql` (אם נוספה טבלה)
- `public/app.js`, `public/sw.js` (פחות סביר)

המלצה: לא לדרוס. למשוך את הענף, להשוות לשינויים המקומיים, ולמזג כך ש־`notify()` יכיל גם את פורמט ה־payload החדש וגם את נתיב ה־FCM.

```bash
git fetch origin claude/youthful-brown-35wv21
git diff HEAD...FETCH_HEAD --stat
# ואז מיזוג ידני של הקבצים שבקונפליקט
```

## איך מפעילים בשרת (PWA)

1. `npm run keys` והגדרת `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` ב־`.env`.
2. אופציונלי: `PUSH_SHOW_CONTENT=false` להתראה כללית.
3. הפעלה מחדש של השירות; ה־worker חייב לרוץ, כי הוא זה ששולח.
4. כל משתמש: להתקין את האתר ("הוסף למסך הבית"), ללחוץ על כפתור ההתראות ולאשר. מכאן, ההרשמה מתחדשת לבד בכל כניסה.

## מה לא נבדק

- לא נבדק על מכשיר או שרת חי. נבדק רק תחביר (`node --check`).
- הבדיקות האוטומטיות דורשות מסד בדיקות (`TEST_DB_NAME` שמסתיים ב־`_test`), ולא רצו בסביבה שבה נכתב הקוד.
- לא ידוע אם בנייה אחרונה של `android-build` עברה.

## בעיה פתוחה: ליטל לא מקבלת התראות

משתמשת באנדרואיד שלא מקבלת פוש. ההשערה הראשונה: ההרשמה של המכשיר נמחקה אחרי התנתקות (`logout` מוחק אותה). בדיקה בשרת:

```bash
mysql chatyemot -e "SELECT u.name, COUNT(s.id) AS devices FROM users u LEFT JOIN push_subscriptions s ON s.user_id=u.id GROUP BY u.id"
```

אם התוצאה 0, צריך שתפתח את האפליקציה אחרי העדכון. אם יש הרשמה והיא עדיין לא מקבלת: הגבלות סוללה של היצרן, "עצור בכוח" ל־Chrome, או הרשאת התראות חסומה. אם זה נמשך, הנתיב הנייטיבי הוא הפתרון המהימן יותר.
