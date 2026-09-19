package com.ting.music.demo

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
    override val handleBackNavigation = false

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Use the app's close buttons so login cancellation and pending
                // playlist writes retain their normal lifecycle/cleanup rules.
                webView.evaluateJavascript("""
                    (() => {
                      const dialog = document.querySelector('dialog[open]');
                      if (dialog) {
                        const close = dialog.querySelector('.dialog-close');
                        if (close && !close.disabled) close.click();
                        return true;
                      }
                      const lyrics = document.querySelector('#lyrics-panel');
                      if (lyrics && !lyrics.hidden) {
                        document.querySelector('#lyrics-close')?.click();
                        return true;
                      }
                      return false;
                    })()
                """.trimIndent()) { handled ->
                    // Returning home must not destroy the WebView audio owner.
                    if (handled != "true") moveTaskToBack(true)
                }
            }
        })
    }
}
