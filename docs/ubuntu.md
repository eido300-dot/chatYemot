# התקנה ועדכון ב־Ubuntu

מדריך להתקנה בשרת עם systemd, MariaDB ו־Nginx או Apache. לאג׳נט מתקין יש גם [הוראות עבודה](install-agent.md). יש להתאים את הדומיין, הסודות והתבניות לסביבה הקיימת; אין סקריפט שמחליף אוטומטית את תצורת השרת.

דרישות: Node.js 22.9.0 ומעלה עם npm (מומלץ 24 LTS), MariaDB 10.6 ומעלה, FFmpeg, Git ו־HTTPS. פקודות npm משתמשות ב־`--env-file-if-exists`, שנוסף ב־22.9.0; גרסאות 22.0–22.8 אינן מתאימות. נבדק מקומית עם Node 24.22.1, MariaDB 11.4 ו־Chromium; פריסה בשרת המשתמש טרם אומתה.

## לפני ההתקנה

- ודאו גישת SSH ו־sudo, דומיין ורשומת DNS המצביעה לשרת.
- בדקו שירותים, פורטים, גרסאות, תעודות ואתרים קיימים. אם Webmin מנהל Apache, השתמשו בתצורה שלו; אל תתקינו Nginx נוסף שמתחרה על פורטים 80 ו־443.
- אם קיימת התקנה, עברו לסעיף העדכון וגבו אותה. אל תדרסו checkout, מסד או `.env` קיימים.
- התקינו דרישות חסרות בדרך המאושרת לשרת. בדקו `node --version`, `npm --version`, `mariadb --version` ו־`ffmpeg -version`. נדרש Node הזמין למשתמש השירות בנתיב מערכת, ולא רק דרך nvm בתיקיית הבית של משתמש אחר.

## 1. קוד ומשתמש שירות

הפקודות הבאות מיועדות להתקנה חדשה בלבד, כששם המשתמש והנתיב עדיין אינם קיימים:

```bash
sudo useradd --system --user-group --home-dir /var/lib/chatyemot --no-create-home --shell /usr/sbin/nologin chatyemot
sudo git clone --branch main https://github.com/eido300-dot/chatYemot.git /opt/chatyemot
sudo chown -R chatyemot:chatyemot /opt/chatyemot
sudo install -d -o chatyemot -g chatyemot -m 0750 /var/lib/chatyemot
cd /opt/chatyemot
sudo -H -u chatyemot npm ci --omit=dev
sudo -H -u chatyemot git log -1 --oneline
```

אין שלב build. הריצו מופע Node אחד בלבד, ללא cluster, כמה workers או תהליך `npm start` נוסף לצד systemd.

## 2. מסד וסודות

צרו באמצעות כלי ניהול המסד של השרת מסד `chatyemot` בקידוד `utf8mb4`, ומשתמש `chatyemot` עם סיסמה ייחודית והרשאות למסד הזה בלבד. התאימו את חשבון המשתמש לחיבור TCP המקומי `127.0.0.1`. אל תשתמשו בחשבון root של MariaDB באפליקציה. הגדירו את הסיסמה בערוץ פרטי שאינו מדפיס אותה או שומר אותה בהיסטוריית פקודות.

צרו קובץ הגדרות מוגן מהדוגמה, רק אם אינו קיים:

```bash
if sudo test -e /opt/chatyemot/.env; then
  printf '%s\n' '.env already exists; keep it and review privately.' >&2
else
  sudo install -o chatyemot -g chatyemot -m 0600 .env.example /opt/chatyemot/.env
fi
```

ערכו אותו בעורך פרטי ללא הקלטת סודות בתמליל האג׳נט. ההגדרות העיקריות:

```dotenv
NODE_ENV=production
PORT=3000
APP_ORIGIN=https://chat.example.com
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=chatyemot
DB_USER=chatyemot
DB_PASSWORD=REPLACE_PRIVATELY
DATA_DIR=/var/lib/chatyemot
YEMOT_ENABLED=false
TZINTUK_ENABLED=false
TRANSCRIPTION_ENABLED=false
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
```

החליפו את הדומיין ואת סיסמת הדוגמה. `APP_ORIGIN` הוא מקור האתר המדויק, ללא נתיב או לוכסן מסיים. שמרו על תאימות ערכי `.env` לטעינה גם ב־Node וגם ב־systemd; לסיסמת מסד שנוצרת אוטומטית אפשר להשתמש בערך אקראי חזק בפורמט hex, ללא תווי ציטוט או רווחים. אין להדפיס את הקובץ, להוסיף אותו ל־Git או למסור אותו בצ׳אט.

הכינו את הסכימה מתוך `/opt/chatyemot`, באמצעות משתמש השירות:

```bash
sudo -H -u chatyemot npm run db:migrate
```

המיגרציה יוצרת טבלאות חסרות ואינה משנה עמודות קיימות. סקריפטי npm טוענים את `.env` מהתיקייה הנוכחית; שירות systemd טוען אותו באמצעות `EnvironmentFile`.

## 3. יצירת מנהל

אין משתמש ברירת מחדל או הרשמה פתוחה. במסוף Bash פרטי, ללא shell tracing או הקלטת הקלט, אפשר להזין סיסמה כך:

```bash
cd /opt/chatyemot
read -r -s -p 'New admin password: ' NEW_USER_PASSWORD
export NEW_USER_PASSWORD
sudo -H --preserve-env=NEW_USER_PASSWORD -u chatyemot npm run user -- admin 'מנהל הקבוצה' '' admin
unset NEW_USER_PASSWORD
```

הדוגמה יוצרת מנהל אתר בלבד. הסיסמה חייבת להיות באורך 12–256 תווים. אם נדרשת כניסה לקו, הזינו גם `NEW_USER_PIN` באופן פרטי, שימרו אותו בהפעלת sudo והחליפו את הארגומנט הריק במספר טלפון ייחודי. ה־PIN נפרד מהסיסמה וכולל 6–12 ספרות. אם מדיניות sudo אינה מאפשרת שימור משתנים, השתמשו במנגנון הסודות המאושר לשרת.

## 4. שירות systemd

בדקו `command -v node` והתאימו את `ExecStart` לנתיב מערכת שנגיש למשתמש השירות. התבנית מניחה `/usr/bin/node`. התאימו גם את שם שירות MariaDB אם הוא שונה בשרת.

תחילה העתיקו את התבנית:

```bash
sudo install -m 0644 deploy/chatyemot.service /etc/systemd/system/chatyemot.service
```

בצעו התאמות בקובץ המותקן **לפני** ההפעלה. כבר בשלב הזה חסמו גישה חיצונית לפורט 3000 ולמסד בחומת האש המקומית ובחומת האש של ספק הענן, תוך שמירת SSH וגישה מקומית ל־proxy. האפליקציה מאזינה על `0.0.0.0`; אין להפעיל אותה לפני שהחסימה קיימת.

ודאו ששירות MariaDB פעיל וש־Node ו־FFmpeg נגישים למשתמש השירות. אמתו את קובץ השירות לפני הפעלה:

```bash
sudo systemd-analyze verify /etc/systemd/system/chatyemot.service
```

פתרו שגיאות אימות, ואז:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now chatyemot
sudo systemctl status chatyemot --no-pager
curl --fail --silent --show-error --max-time 5 --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:3000/health
```

השירות רץ כ־`chatyemot`, עם כתיבה ל־`/var/lib/chatyemot` בלבד. אל תריצו את האפליקציה כ־root.

## 5. דומיין, HTTPS ורשת

שלבו את [`deploy/nginx.conf.example`](../deploy/nginx.conf.example) בתוך בלוק HTTPS של הדומיין הקיים, והגדירו תעודה תקינה וחידוש אוטומטי. זו תבנית חלקית, ולא קובץ Nginx מלא. היא כוללת הגבלת העלאה ו־reverse proxy אל `127.0.0.1:3000`.

אם Apache/Webmin מנהל את האתר, הגדירו בו reverse proxy מקביל עם תמיכה בהעלאת שמע ובכותרות forwarded. בדקו תצורה באמצעות `nginx -t` או `apachectl configtest`, לפי השרת, ורק לאחר הצלחה בצעו reload.

אפשרו גישה ציבורית ל־HTTPS, ול־HTTP אם נדרש להפניה או להנפקת תעודות. חסמו גישה חיצונית לפורט 3000 ולמסד גם בחומת האש של ספק הענן, תוך שמירת גישת SSH. האפליקציה מאזינה על `0.0.0.0`, ולכן אין להסתמך על reverse proxy לבדו כחסימה.

מנעו רישום הנתיב הסודי `/ivr/…` בלוגים של ה־proxy ושל כל שכבת CDN/WAF; ראו את תבנית Nginx ואת [מדריך האינטגרציות](integrations.md).

## 6. אימות וקבלת ההתקנה

- בדקו `https://YOUR_DOMAIN/health` והפעלת השירות ללא שגיאות. `/health` בודק את המסד, ולא ספקים או תקינות תור המשימות.
- בדקו בדפדפן: כניסת המנהל, שליחת טקסט, תגובה, עריכה, העלאת שמע, האזנה ויציאה. בדקו שהמיקרופון נעצר ביציאה אם נבדקה הקלטה.
- הפעילו מחדש באמצעות `sudo systemctl restart chatyemot`, ודאו שהנתונים נשמרו ושבדיקת הבריאות עדיין עוברת.
- ודאו גישה דרך HTTPS וחסימה חיצונית של פורט 3000 והמסד. בדקו את מסך הניהול והגדירו ניטור למשימות `failed` או `uncertain`.
- תעדו את הקומיט, הגרסאות, כתובת האתר ותוצאות האימות. אל תציגו בדיקה שלא הורצה כבדיקה שעברה.

**אין להריץ `npm test`, `npm run test:browser` או `scripts/dev-db.sh` מול סביבת הייצור.** הבדיקות משתמשות במסד ייעודי ששמו מסתיים ב־`_test` ועלולות למחוק את תוכנו.

בהתקנה חדשה השאירו אינטגרציות כבויות. הפעלת ימות, צינתוק, פוש ותמלול היא שלב נפרד לפי [integrations.md](integrations.md), עם בדיקת התור הקיים ואישור הפעלה. אין לשלוח התראות על היסטוריה כחלק מבדיקת ההתקנה.

## עדכון התקנה קיימת וגיבוי

1. תעדו את הקומיט הנוכחי ובדקו שינויים מקומיים. אל תאפסו אותם.
2. עצרו את השירות לזמן העדכון וגבו יחד את מסד MariaDB ואת כל `DATA_DIR`, כך שקובצי השמע ותוכן המסד תואמים. שמרו גם את `.env` בגיבוי סודות מוגן. גיבוי Git אינו גיבוי נתונים.
3. עדכנו את checkout של `main` באמצעות fast-forward בלבד, מחשבון מתאים, ואז הריצו `npm ci --omit=dev` כמשתמש השירות. אל תחליפו `.env` או הגדרות ספקים קיימות בדוגמאות.
4. בדקו אם העדכון דורש מיגרציה. בתיקון `bbe2313` אין שינוי סכימה. לפני שינוי סכימה עתידי הכינו גם תוכנית שחזור; `db:migrate` הנוכחי אינו משדרג עמודות קיימות.
5. הפעילו את השירות והריצו שוב את בדיקות הקבלה לעיל. אם העדכון נכשל, חזרו לקומיט הקודם ולתלויות שלו; שינויי סכימה או נתונים עשויים לחייב שחזור הגיבוי המתאים.

בדקו שחזור גיבוי בסביבה נפרדת. Docker volumes של הפיתוח אינם שיטת הפריסה המומלצת לשרת קיים עם MariaDB.

## פקודות תפעול

```bash
sudo systemctl restart chatyemot
sudo systemctl status chatyemot --no-pager
sudo journalctl -u chatyemot -n 100 --no-pager
```

לפני שיתוף לוגים הסירו סודות, מזהי משתמשים ונתיבי webhook פרטיים.
