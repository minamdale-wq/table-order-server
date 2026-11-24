package kr.friendsscreen.tableorder;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 태블릿을 켜면 앱을 띄운다. (안드로이드 10 이상은 '기본 홈 앱'으로 지정해야 확실하게 뜬다) */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        try {
            Intent i = new Intent(ctx, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            ctx.startActivity(i);
        } catch (Exception ignored) { }
    }
}
