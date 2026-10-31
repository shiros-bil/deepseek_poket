package ai.freedeepseek.pocket;

import android.app.Activity;
import android.content.Context;
import android.os.Build;
import android.view.View;

final class Ui {
    static boolean russian(Context c) {try{return new Store(c).preferences().getString("language").equals("ru");}catch(Exception ignored){return false;}}
    static boolean dark(Context c) {try{return !new Store(c).preferences().getString("theme").equals("light");}catch(Exception ignored){return true;}}
    static String text(Context c,String en,String ru){return russian(c)?ru:en;}
    static int background(Context c){return dark(c)?0xff101010:0xfff6f6f6;}
    static int foreground(Context c){return dark(c)?0xfff2f2f2:0xff171717;}
    static void prepare(Activity a){a.setTheme(dark(a)?R.style.AppThemeDark:R.style.AppTheme);}
    static void applyWindow(Activity a){
        prepare(a);int color=background(a);a.getWindow().setStatusBarColor(color);a.getWindow().setNavigationBarColor(color);
        int flags=0;if(!dark(a)){flags|=View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;if(Build.VERSION.SDK_INT>=27)flags|=View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;}
        a.getWindow().getDecorView().setSystemUiVisibility(flags);
    }
    static String translate(Context c,String value){
        if(value==null||russian(c))return value;
        return switch(value){
            case "Сначала остановите сервер, затем измените настройки или аккаунты." -> "Stop the server before changing connection settings or accounts.";
            case "Порт должен быть от 1024 до 65535." -> "The port must be between 1024 and 65535.";
            case "Слишком большой файл настроек." -> "The settings file is too large.";
            case "Допустимы строки DEEPSEEK_ИМЯ=значение и комментарии #." -> "Use DEEPSEEK_NAME=value lines and # comments.";
            case "Ключ: минимум 24 латинских символа, цифры, точка, - или _." -> "Use at least 24 characters: Latin letters, digits, dot, - or _.";
            case "Нужны token и cookie. Для cookies.json укажите токен в отдельном поле." -> "Token and cookie are required. For cookies.json, enter a token in the separate field.";
            case "wasmUrl должен начинаться с https://." -> "wasmUrl must start with https://.";
            case "Неизвестный аккаунт." -> "Unknown account.";
            case "Не удалось удалить аккаунт." -> "Could not remove the account.";
            case "Не удалось сохранить файл." -> "Could not save the file.";
            case "Журнал пока пуст." -> "No logs yet.";
            case "Файл или ответ слишком большой." -> "The file or response is too large.";
            case "Добавьте аккаунт DeepSeek во вкладке «Аккаунты»." -> "Add a DeepSeek account in the Accounts tab.";
            case "Неизвестная команда." -> "Unknown command.";
            case "Дождитесь ответа или остановите текущую генерацию." -> "Wait for the response or stop the current generation.";
            case "Журнал сохранён" -> "Logs saved";
            case "Выберите PNG, JPEG, WebP или GIF." -> "Choose a PNG, JPEG, WebP or GIF image.";
            default -> value;
        };
    }
}
