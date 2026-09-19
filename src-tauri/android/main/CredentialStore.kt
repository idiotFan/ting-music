package com.ting.music.demo

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Only ciphertext is persisted, outside Android backup/device-transfer data. */
internal class CredentialStore(context: Context, private val namespace: String = "credentials-v1") {
    private val directory = File(context.noBackupFilesDir, namespace)
    private val alias = "com.ting.music.demo.$namespace"

    private fun record(account: String): AtomicFile {
        require(account == "netease-session" || account == "qq-session")
        check(directory.isDirectory || directory.mkdirs())
        return AtomicFile(File(directory, "$account.enc"))
    }

    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        check(create) { "Credential key unavailable" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build())
            generateKey()
        }
    }

    // All store instances share the lock, including during instrumentation and re-creation.
    fun read(account: String): String? = synchronized(lock) {
        val file = record(account)
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return@synchronized null
        val bytes = file.readFully()
        require(bytes.size in 30..MAX_RECORD_SIZE && bytes[0] == 1.toByte())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        cipher.updateAAD("$namespace/$account".toByteArray(Charsets.UTF_8))
        String(cipher.doFinal(bytes, 13, bytes.size - 13), Charsets.UTF_8)
    }

    fun write(account: String, value: String) = synchronized(lock) {
        val file = record(account)
        val plaintext = value.toByteArray(Charsets.UTF_8)
        require(plaintext.isNotEmpty() && plaintext.size <= MAX_RECORD_SIZE - 29)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(true))
        check(cipher.iv.size == 12)
        cipher.updateAAD("$namespace/$account".toByteArray(Charsets.UTF_8))
        val encrypted = byteArrayOf(1) + cipher.iv + cipher.doFinal(plaintext)
        val stream = file.startWrite()
        try {
            stream.write(encrypted)
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
    }

    fun remove(account: String) = synchronized(lock) {
        val file = record(account)
        file.delete()
        check(listOf("", ".bak", ".new").none { File(file.baseFile.path + it).exists() }) { "Credential removal failed" }
        // Shared key remains valid for the other provider.
    }

    companion object {
        private val lock = Any()
        private const val MAX_RECORD_SIZE = 1024 * 1024
    }
}
