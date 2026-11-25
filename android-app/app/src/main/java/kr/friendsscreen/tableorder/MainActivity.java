package kr.friendsscreen.tableorder;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 테이블 오더 주문용 앱.
 * 화면은 매장 서버(미니 서버)의 웹 화면을 그대로 띄운다. 그래서 서버에서 '업데이트'를 누르면 앱을 다시 깔 필요가 없다.
 * 앱이 하는 일: 전체 화면, 화면 꺼짐 방지, 부팅 시 자동 실행, 화면 고정, 연결 끊김 시 자동 재시도, 동영상 소리 자동 재생 허용.
 */
public class MainActivity extends Activity {
    static final String DEF_SERVER = "192.168.219.81:8765";
    static final int GREEN = 0xFF24503A, CREAM = 0xFFF6EFE4, PAPER = 0xFFFFFDF8, INK = 0xFF2B2620, MUTE = 0xFF7C7366, GOLD = 0xFFDCC7A3, RED = 0xFFC0392B;

    SharedPreferences prefs;
    FrameLayout root;
    WebView web;
    TextView offline;
    boolean inSetup = false, pageError = false;
    final Handler h = new Handler(Looper.getMainLooper());
    final Runnable reload = new Runnable() { public void run() { load(); } };
    int taps = 0;
    int fails = 0;
    volatile boolean discovering = false;
    long firstTap = 0;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
        prefs = getSharedPreferences("tod", MODE_PRIVATE);
        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF14130F);
        setContentView(root);
        applyOrientation();
        if (prefs.getString("tab", null) == null) showSetup(); else showWeb();
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideBars();
        if (!inSetup) lockIfWanted();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideBars();
    }

    @Override
    public void onBackPressed() {
        // 손님이 뒤로 가기로 앱을 나가지 못하게 막는다
        if (inSetup && prefs.getString("tab", null) != null) showWeb();
    }

    /* ---------- 화면 ---------- */
    void hideBars() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    void applyOrientation() {
        setRequestedOrientation(prefs.getBoolean("portrait", true) ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
    }

    void lockIfWanted() {
        if (!prefs.getBoolean("pin", false)) return;
        try { startLockTask(); } catch (Exception ignored) { }
    }

    void unlock() {
        try { stopLockTask(); } catch (Exception ignored) { }
    }

    String server() { return prefs.getString("server", DEF_SERVER); }
    String tab() { return prefs.getString("tab", "t1"); }

    /* ---------- 웹 화면 ---------- */
    void showWeb() {
        inSetup = false;
        h.removeCallbacks(reload);
        root.removeAllViews();
        if (web != null) { try { web.destroy(); } catch (Exception ignored) { } }
        web = new WebView(this);
        web.setBackgroundColor(0xFF14130F);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // 동영상 소리 자동 재생 허용
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= 21) s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " TableOrderApp/" + BuildConfigVersion());
        web.addJavascriptInterface(new Bridge(), "TODApp");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                return !url.startsWith("http://" + server()) && !url.startsWith("https://" + server());
            }
            @Override
            public void onPageFinished(WebView v, String url) {
                if (!pageError) { offline.setVisibility(View.GONE); fails = 0; }
            }
            @Override
            public void onReceivedError(WebView v, int code, String desc, String url) {
                if (Build.VERSION.SDK_INT < 23) showOffline(desc);
            }
            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (Build.VERSION.SDK_INT >= 23 && req.isForMainFrame()) showOffline(String.valueOf(err.getDescription()));
            }
            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest req, WebResourceResponse res) {
                if (req.isForMainFrame() && res.getStatusCode() >= 500) showOffline("HTTP " + res.getStatusCode());
            }
            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
                // 화면 엔진이 죽으면 새로 만든다
                h.post(new Runnable() { public void run() { showWeb(); } });
                return true;
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        offline = new TextView(this);
        offline.setBackgroundColor(0xF214130F);
        offline.setTextColor(Color.WHITE);
        offline.setGravity(Gravity.CENTER);
        offline.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        offline.setLineSpacing(0, 1.3f);
        offline.setVisibility(View.GONE);
        root.addView(offline, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        load();
        hideBars();
        lockIfWanted();
    }

    void load() {
        if (web == null || inSetup) return;
        pageError = false;
        h.removeCallbacks(reload);
        web.loadUrl("http://" + server() + "/#" + tab());
    }

    void showOffline(String why) {
        pageError = true;
        offline.setVisibility(View.VISIBLE);
        h.removeCallbacks(reload);
        if (discovering) return;
        fails++;
        if (fails >= 2) {
            // 두 번 연속 실패하면 매장 와이파이 안에서 서버를 직접 찾는다 (서버 주소가 바뀐 경우)
            discovering = true;
            offline.setText("매장 서버에 연결할 수 없습니다\n\n" + server() + "\n\n매장 와이파이에서 서버를 찾는 중…");
            new Thread(() -> {
                final String f = discover();
                h.post(() -> {
                    discovering = false;
                    if (f != null && !f.equals(server())) {
                        prefs.edit().putString("server", f).apply();
                        toast("매장 서버를 찾았습니다: " + f);
                    }
                    if (f != null) fails = 0;
                    if (inSetup) return;
                    if (f == null) {
                        offline.setText("매장 서버를 찾지 못했습니다\n\n서버 컴퓨터가 켜져 있는지, 이 태블릿이 매장 와이파이에 연결돼 있는지 확인해 주세요\n\n잠시 뒤 다시 찾습니다");
                        h.postDelayed(reload, 15000);
                    } else load();
                });
            }).start();
            return;
        }
        offline.setText("매장 서버에 연결할 수 없습니다\n\n" + server() + "\n(" + why + ")\n\n5초 뒤 자동으로 다시 연결합니다");
        h.postDelayed(reload, 5000);
    }

    /* ---------- 매장 서버 자동 찾기 ---------- */
    static String probeInfo(String hostPort, int cto, int rto) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://" + hostPort + "/api/info").openConnection();
            c.setConnectTimeout(cto);
            c.setReadTimeout(rto);
            c.setUseCaches(false);
            if (c.getResponseCode() != 200) return null;
            String b = read(c.getInputStream());
            return (b.contains("\"addresses\"") && b.contains("\"startedAt\"")) ? b : null;
        } catch (Exception e) {
            return null;
        } finally { if (c != null) c.disconnect(); }
    }

    static List<String> localPrefixes() {
        List<String> out = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) {
                        String ip = a.getHostAddress();
                        String p = ip.substring(0, ip.lastIndexOf('.') + 1);
                        if (!out.contains(p)) out.add(p);
                    }
                }
            }
        } catch (Exception ignored) { }
        return out;
    }

    /** 저장된 주소 → 기본 주소 → 같은 와이파이의 모든 주소(포트 8765 먼저) 순서로 찾는다. 못 찾으면 null */
    String discover() {
        if (probeInfo(server(), 1500, 2500) != null) return server();
        if (!DEF_SERVER.equals(server()) && probeInfo(DEF_SERVER, 1500, 2500) != null) return DEF_SERVER;
        int[] ports = {8765, 8899, 9080, 18080, 28080};
        List<String> prefixes = localPrefixes();
        ExecutorService ex = Executors.newFixedThreadPool(48);
        try {
            for (int port : ports) {
                for (String pre : prefixes) {
                    final AtomicReference<String> found = new AtomicReference<>(null);
                    List<Future<?>> fs = new ArrayList<>();
                    for (int i = 1; i <= 254; i++) {
                        final String hp = pre + i + ":" + port;
                        fs.add(ex.submit(() -> {
                            if (found.get() == null && probeInfo(hp, 450, 1500) != null) found.compareAndSet(null, hp);
                        }));
                    }
                    for (Future<?> f : fs) {
                        if (found.get() != null) break;
                        try { f.get(); } catch (Exception ignored) { }
                    }
                    if (found.get() != null) return found.get();
                }
            }
        } finally { ex.shutdownNow(); }
        return null;
    }

    String BuildConfigVersion() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }

    /** 웹 화면에서 쓸 수 있는 함수: TODApp.version(), TODApp.openSettings() */
    class Bridge {
        @JavascriptInterface public String version() { return BuildConfigVersion(); }
        @JavascriptInterface public String tabletId() { return tab(); }
        @JavascriptInterface public void openSettings() { h.post(new Runnable() { public void run() { askPin(); } }); }
    }

    /* ---------- 숨은 설정: 왼쪽 위 모서리를 4초 안에 7번 누르기 ---------- */
    @Override
    public boolean dispatchTouchEvent(MotionEvent e) {
        if (!inSetup && e.getActionMasked() == MotionEvent.ACTION_DOWN) {
            float lim = dp(110);
            if (e.getX() < lim && e.getY() < lim) {
                long now = System.currentTimeMillis();
                if (now - firstTap > 4000) { taps = 0; firstTap = now; }
                if (++taps >= 7) { taps = 0; askPin(); }
            }
        }
        return super.dispatchTouchEvent(e);
    }

    void askPin() {
        final EditText in = new EditText(this);
        in.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        in.setHint("관리 PIN");
        in.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        new AlertDialog.Builder(this)
                .setTitle("앱 설정 열기")
                .setMessage("주문받는 태블릿과 같은 관리 PIN을 넣어 주세요.")
                .setView(in)
                .setPositiveButton("확인", (d, w) -> checkPin(in.getText().toString().trim()))
                .setNegativeButton("취소", null)
                .show();
    }

    void checkPin(final String pin) {
        new Thread(() -> {
            int r = postPin(pin); // 1 맞음, 0 틀림, -1 서버 연결 안 됨
            h.post(() -> {
                if (r == 1 || r == -1) {
                    if (r == -1) toast("서버에 연결되지 않아 PIN 확인 없이 설정을 엽니다");
                    showSetup();
                } else toast("PIN이 맞지 않습니다");
            });
        }).start();
    }

    int postPin(String pin) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://" + server() + "/api/auth/check").openConnection();
            c.setConnectTimeout(4000); c.setReadTimeout(4000);
            c.setRequestMethod("POST"); c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            OutputStream os = c.getOutputStream();
            os.write(("{\"pin\":\"" + pin.replaceAll("[^0-9]", "") + "\"}").getBytes("UTF-8")); os.close();
            String body = read(c.getResponseCode() < 400 ? c.getInputStream() : c.getErrorStream());
            return body.replace(" ", "").contains("\"ok\":true") ? 1 : 0;
        } catch (Exception e) {
            return -1;
        } finally { if (c != null) c.disconnect(); }
    }

    /* ---------- 설정 화면 ---------- */
    void showSetup() {
        inSetup = true;
        unlock();
        h.removeCallbacks(reload);
        root.removeAllViews();
        if (web != null) { try { web.destroy(); } catch (Exception ignored) { } web = null; }

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(CREAM);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(28);
        col.setPadding(pad, dp(36), pad, dp(36));
        sv.addView(col);
        root.addView(sv, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView t = text("테이블 오더 · 주문용 앱 설정", 28, INK, true);
        t.setTypeface(Typeface.create(Typeface.SERIF, Typeface.BOLD));
        col.addView(t);
        col.addView(text("앱 버전 " + BuildConfigVersion() + " · 화면과 메뉴는 매장 서버에서 받아 오므로, 서버만 업데이트하면 됩니다.", 15, MUTE, false));

        col.addView(label("매장 서버 주소"));
        final EditText srv = new EditText(this);
        srv.setText(server());
        srv.setSingleLine(true);
        srv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        srv.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        box(srv);
        col.addView(srv);
        col.addView(text("보통은 건드릴 필요 없습니다. 앱이 매장 와이파이에서 서버를 자동으로 찾고, 서버 주소가 바뀌어도 스스로 다시 찾습니다.", 14, MUTE, false));

        col.addView(label("이 태블릿 번호"));
        final String[] chosen = { prefs.getString("tab", "") };
        LinearLayout grid = new LinearLayout(this);
        grid.setOrientation(LinearLayout.VERTICAL);
        col.addView(grid);
        final Button[] nb = new Button[8];
        for (int row = 0; row < 2; row++) {
            LinearLayout r = new LinearLayout(this);
            r.setOrientation(LinearLayout.HORIZONTAL);
            grid.addView(r);
            for (int k = 0; k < 4; k++) {
                final int n = row * 4 + k + 1;
                Button bt = new Button(this);
                bt.setText(n + "번");
                bt.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
                bt.setAllCaps(false);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(72), 1f);
                lp.setMargins(dp(4), dp(4), dp(4), dp(4));
                r.addView(bt, lp);
                nb[n - 1] = bt;
                bt.setOnClickListener(v -> { chosen[0] = "t" + n; paintNums(nb, chosen[0]); });
            }
        }
        paintNums(nb, chosen[0]);
        col.addView(text("주문용 태블릿은 1~6번입니다. 번호는 주문받는 태블릿의 '태블릿' 탭 목록과 같습니다.", 14, MUTE, false));

        final CheckBox portrait = check("세로 화면으로 고정", prefs.getBoolean("portrait", true));
        col.addView(portrait);
        final CheckBox pin = check("화면 고정 (손님이 앱 밖으로 나가지 못하게)", prefs.getBoolean("pin", false));
        col.addView(pin);
        col.addView(text("화면 고정을 처음 켜면 안드로이드가 '앱 고정' 확인 창을 띄웁니다. 풀 때는 이 설정 화면(왼쪽 위 모서리 7번 누르기 → PIN)에서 끄면 됩니다.", 14, MUTE, false));

        final TextView status = text("", 17, GREEN, true);
        status.setPadding(0, dp(16), 0, 0);

        Button find = button("서버 자동으로 찾기", false);
        final Runnable doFind = () -> {
            status.setTextColor(MUTE);
            status.setText("매장 와이파이에서 서버를 찾는 중… (10초쯤 걸립니다)");
            new Thread(() -> {
                final String f = discover();
                h.post(() -> {
                    if (f != null) { srv.setText(f); status.setTextColor(GREEN); status.setText("✓ 매장 서버를 찾았습니다: " + f); }
                    else { status.setTextColor(RED); status.setText("✕ 서버를 찾지 못했습니다. 서버 컴퓨터가 켜져 있고, 이 태블릿이 매장 와이파이에 연결됐는지 확인해 주세요"); }
                });
            }).start();
        };
        find.setOnClickListener(v -> doFind.run());

        Button test = button("연결 확인", false);
        test.setOnClickListener(v -> {
            final String a = clean(srv.getText().toString());
            status.setTextColor(MUTE);
            status.setText("확인 중…");
            new Thread(() -> {
                String res;
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL("http://" + a + "/api/info").openConnection();
                    c.setConnectTimeout(4000); c.setReadTimeout(4000);
                    String body = read(c.getInputStream());
                    String ver = body.replaceAll("(?s).*\"version\"\\s*:\\s*\"([^\"]+)\".*", "$1");
                    res = "✓ 연결됨 · 서버 버전 " + (ver.length() < 20 ? ver : "?");
                } catch (Exception e) {
                    res = "✕ 연결 안 됨: 주소와 와이파이를 확인해 주세요 (" + e.getClass().getSimpleName() + ")";
                }
                final String fr = res;
                h.post(() -> { status.setTextColor(fr.startsWith("✓") ? GREEN : RED); status.setText(fr); });
            }).start();
        });
        col.addView(find);
        col.addView(test);
        col.addView(status);
        if (prefs.getString("tab", null) == null) doFind.run();   // 처음 설치했을 때는 바로 찾아서 채워 둔다

        Button home = button("기본 홈 앱으로 지정 (켜자마자 자동 실행)", false);
        home.setOnClickListener(v -> {
            try { startActivity(new Intent(Settings.ACTION_HOME_SETTINGS)); }
            catch (Exception e) { try { startActivity(new Intent(Settings.ACTION_SETTINGS)); } catch (Exception ignored) { } }
        });
        col.addView(home);
        col.addView(text("열리는 화면에서 '테이블 오더'를 기본 홈 앱으로 고르면, 태블릿을 켜거나 홈 버튼을 눌러도 이 앱이 바로 뜹니다. 원래대로 돌리려면 같은 화면에서 기존 홈 앱을 고르면 됩니다.", 14, MUTE, false));

        Button go = button("저장하고 시작", true);
        go.setOnClickListener(v -> {
            String a = clean(srv.getText().toString());
            if (a.isEmpty()) { toast("서버 주소를 넣어 주세요"); return; }
            if (chosen[0] == null || chosen[0].isEmpty()) { toast("이 태블릿 번호를 골라 주세요"); return; }
            prefs.edit().putString("server", a).putString("tab", chosen[0])
                    .putBoolean("portrait", portrait.isChecked()).putBoolean("pin", pin.isChecked()).apply();
            applyOrientation();
            showWeb();
        });
        col.addView(go);

        if (prefs.getString("tab", null) != null) {
            Button cancel = button("취소 (바꾸지 않고 돌아가기)", false);
            cancel.setOnClickListener(v -> showWeb());
            col.addView(cancel);
        }
        hideBars();
    }

    void paintNums(Button[] nb, String chosen) {
        for (int i = 0; i < nb.length; i++) {
            boolean on = ("t" + (i + 1)).equals(chosen);
            GradientDrawable g = new GradientDrawable();
            g.setCornerRadius(dp(36));
            g.setColor(on ? GREEN : PAPER);
            g.setStroke(dp(2), on ? GREEN : GOLD);
            nb[i].setBackground(g);
            nb[i].setTextColor(on ? Color.WHITE : INK);
        }
    }

    /* ---------- 작은 도우미 ---------- */
    String clean(String a) {
        a = a.trim().replaceFirst("^https?://", "");
        int i = a.indexOf('/');
        if (i >= 0) a = a.substring(0, i);
        return a;
    }

    static String read(InputStream in) throws Exception {
        if (in == null) return "";
        BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = r.readLine()) != null) sb.append(line);
        r.close();
        return sb.toString();
    }

    int dp(float v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()); }

    TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(4), 0, dp(4));
        return t;
    }

    TextView label(String s) {
        TextView t = text(s, 18, INK, true);
        t.setPadding(0, dp(24), 0, dp(8));
        return t;
    }

    void box(View v) {
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(dp(14));
        g.setColor(PAPER);
        g.setStroke(dp(2), GOLD);
        v.setBackground(g);
        v.setPadding(dp(16), dp(14), dp(16), dp(14));
    }

    CheckBox check(String s, boolean on) {
        CheckBox c = new CheckBox(this);
        c.setText(s);
        c.setChecked(on);
        c.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        c.setTextColor(INK);
        c.setPadding(dp(8), dp(14), 0, dp(14));
        return c;
    }

    Button button(String s, boolean primary) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        b.setTextColor(primary ? Color.WHITE : INK);
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(dp(40));
        g.setColor(primary ? GREEN : PAPER);
        g.setStroke(dp(2), primary ? GREEN : GOLD);
        b.setBackground(g);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(72));
        lp.setMargins(0, dp(18), 0, 0);
        b.setLayoutParams(lp);
        return b;
    }

    void toast(String s) { android.widget.Toast.makeText(this, s, android.widget.Toast.LENGTH_LONG).show(); }
}
