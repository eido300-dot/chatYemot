# אפליקציית אנדרואיד – צ'אטייב

מעטפת WebView נייטיבית (Kotlin) שטוענת את האתר `https://stamandsefer.co.il/`, מתאימה לטאבלט (סיבוב מסך מלא, RTL), תומכת בהקלטה (מיקרופון), העלאת קבצים, ומתעדכנת מ‑GitHub Releases.
תוכן האתר תמיד עדכני מהשרת; רק שינויים באפליקציה עצמה עוברים דרך APK.

## הגדרה חד‑פעמית
1. יצירת keystore (חייב להישמר! אותו מפתח נדרש לכל עדכון):
   `keytool -genkeypair -v -keystore release.jks -alias chatyemot -keyalg RSA -keysize 2048 -validity 10000`
2. ב‑GitHub: Settings → Secrets → Actions, להוסיף:
   `KEYSTORE_BASE64` (`base64 -w0 release.jks`), `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.
3. **ריפו פרטי**: האפליקציה לא תוכל לקרוא Releases בלי טוקן. ליצור fine‑grained token עם `Contents: Read-only` לריפו הזה בלבד ולשמור כסוד `UPDATE_TOKEN`
   (הוא נבנה לתוך ה‑APK, לכן רק קריאה ורק לריפו זה). בריפו ציבורי אין צורך.

## פרסום גרסה / עדכון
```sh
git tag v1.0.1 && git push origin v1.0.1
```
ה‑Workflow בונה APK חתום ומפרסם Release. בפתיחה הבאה האפליקציה תציע עדכון ותתקין אותו.

## התקנה ראשונה בטאבלט
להוריד את ה‑APK מדף ה‑Release, ולאשר "התקנה ממקורות לא ידועים". בהתקנת העדכון הראשון האפליקציה תבקש הרשאה דומה.

## התראות (FCM, כמו וואטסאפ)
גוגל מעירה את האפליקציה רק כשיש הודעה, בלי חיבור פתוח ובלי ניקוז סוללה. דרך גוגל עובר **רק מזהה ההודעה**; הטקסט נמשך מהשרת שלכם, כך שתוכן ההודעות לא עובר ב‑Firebase.
על כל הודעה של מישהו אחר: התראה קופצת, המסך נדלק ל‑8 שניות, ועם:
- שם השולח והטקסט (בהקלטה: "הודעה קולית")
- **השמע** – מנגן את ההקלטה ומסמן כנקרא
- **השב** – תשובה ישירה מההתראה, נשלחת כתגובה (quote) להודעה

צריך להתחבר פעם אחת באפליקציה (הטוקן נרשם בשרת אחרי הכניסה). בפעם הראשונה רק הודעות חדשות יתריעו.

### הקמת Firebase (חד‑פעמי, חינם, חשבון גוגל רגיל)
1. https://console.firebase.google.com → Add project (בלי Analytics).
2. Project settings → Add app → Android. Package name: `il.co.stamandsefer.chatyemot`. להוריד `google-services.json`.
   ב‑GitHub Secrets: `GOOGLE_SERVICES_JSON` = `base64 -w0 google-services.json`.
3. Project settings → Service accounts → Generate new private key (קובץ JSON). להעתיק לשרת (מחוץ ל‑git, הרשאות 600), ובקובץ `.env` בשרת:
   `FCM_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`, ואז הפעלה מחדש של השרת (המיגרציה יוצרת טבלת `fcm_tokens` אוטומטית: `npm run db:migrate`).
4. בקונסול, APIs: לוודא ש‑"Firebase Cloud Messaging API (V1)" מופעל.

## מגבלות
- Web Push של האתר לא פעיל בתוך האפליקציה; במקומו יש השירות הנייטיב.
- ההקלטה מגיעה בהתראה לפני שהתמלול מוכן, לכן מוצג "הודעה קולית" ולא התמלול.
- לא נבנה כאן (אין Java/Android SDK בשרת); הבנייה רצה ב‑GitHub Actions.
