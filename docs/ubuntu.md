# התקנה ב־Ubuntu

דרישות: Node.js 22 ומעלה, MariaDB 10.6 ומעלה, FFmpeg, Nginx או Apache עם reverse proxy ו־TLS. נבדק מקומית עם Node 24.22.1, MariaDB 11.4 ו־FFmpeg. לא נבדק על שרת המשתמש; יש לברר גרסאות ומנהל HTTP ב־Webmin לפני העתקת תבניות.

1. פרסו את הפרויקט ל־`/opt/chatyemot`, צרו משתמש שירות `chatyemot`, והתקינו עם `npm ci --omit=dev`.
2. צרו מסד `chatyemot` ב־utf8mb4 ומשתמש ייעודי המוגבל למסד זה; אל תשתמשו ב־root. ערכו `.env` לפי הדוגמה, הרשאות 0600, בעלות משתמש השירות. בייצור: `NODE_ENV=production`, `APP_ORIGIN=https://YOUR_DOMAIN`, סיסמת מסד ייחודית ו־`DATA_DIR=/var/lib/chatyemot`.
3. צרו תיקיית נתונים בבעלות משתמש השירות והריצו `npm run db:migrate` באותה סביבה. המיגרציה יוצרת טבלאות חסרות; אינה משנה עמודות קיימות. גיבוי נדרש לפני כל שינוי סכימה עתידי.
4. צרו מנהל עם כלי `npm run user`, לפי README. הזינו סיסמה ו־PIN דרך environment מאובטח. אין חשבון ברירת מחדל.
5. התאימו `deploy/chatyemot.service`, כולל נתיב Node (`command -v node`), פרסו והפעילו ב־systemd. הריצו מופע אחד בלבד; אין cluster או כמה workers.
6. התאימו את תבנית Nginx עם TLS תקין. אם Webmin מנהל Apache, הגדירו בו reverse proxy מקביל בלי להחליף תצורה קיימת. חסמו גישה חיצונית לפורט 3000; reverse proxy ומסד מקומיים בלבד.
7. בדקו `/health`, כניסה, כתיבת הודעה, העלאת שמע, האזנה ויציאה. `/health` בודק את מסד הנתונים, לא אישורי ספקים או תקינות התור. בדקו מסך משימות מנהל והגדירו ניטור לכישלונות/uncertain.
8. הפעילו אינטגרציות בנפרד לפי integrations.md, עם בדיקת התור הקיים ואימות מול ספק חי.

גיבוי: MariaDB dump עקבי ותיקיית DATA_DIR. בדקו שחזור בסביבה נפרדת. Docker volumes של הפיתוח אינם אופן הפריסה המומלץ לשרת קיים עם MariaDB. אל תפעילו את dev-db.sh על שרת הייצור.
