package com.ting.music.demo

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.util.concurrent.Executors

@InvokeArg
class CredentialArgs {
    lateinit var account: String
    var value: String? = null
}

@TauriPlugin
class CredentialPlugin(activity: Activity) : Plugin(activity) {
    private val store = CredentialStore(activity.applicationContext)

    private fun execute(invoke: Invoke, operation: (CredentialArgs) -> JSObject?) {
        // Keystore and disk work must not block Android's UI thread.
        worker.execute {
            try {
                val result = operation(invoke.parseArgs(CredentialArgs::class.java))
                if (result == null) invoke.resolve() else invoke.resolve(result)
            } catch (_: Exception) {
                // Native exception text can contain sensitive values; never forward it.
                invoke.reject("Secure credential operation failed")
            }
        }
    }

    @Command
    fun read(invoke: Invoke) = execute(invoke) { args ->
        JSObject().put("value", store.read(args.account) ?: JSONObject.NULL) as JSObject
    }

    @Command
    fun write(invoke: Invoke) = execute(invoke) { args ->
        store.write(args.account, requireNotNull(args.value))
        null
    }

    @Command
    fun remove(invoke: Invoke) = execute(invoke) { args ->
        store.remove(args.account)
        null
    }

    companion object {
        private val worker = Executors.newSingleThreadExecutor()
    }
}
