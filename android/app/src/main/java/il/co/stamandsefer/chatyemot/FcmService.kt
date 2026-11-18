package il.co.stamandsefer.chatyemot

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** גוגל מעירה את האפליקציה רק כשיש הודעה; אין חיבור פתוח וצריכת הסוללה זניחה. */
class FcmService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Api.registerFcmToken(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data["type"] == "message")
            runCatching { Notifier.fetchAndShow(this) }.onFailure { Notifier.showGeneric(this) }
    }
}
