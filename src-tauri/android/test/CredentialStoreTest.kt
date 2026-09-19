package com.ting.music.demo

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.Assume.assumeTrue
import java.io.File
import java.security.KeyStore

/** Runs on a real Android Keystore; fixtures never touch either real account. */
class CredentialStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val netease = "netease-session"
    private val qq = "qq-session"
    private val fixture = "fixture-only-cookie-非真实凭据"

    private fun cleanup(namespace: String) {
        File(context.noBackupFilesDir, namespace).deleteRecursively()
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            .deleteEntry("com.ting.music.demo.$namespace")
    }

    private fun withStore(name: String, test: (CredentialStore, File) -> Unit) {
        val namespace = "credential-test-$name"
        cleanup(namespace)
        try {
            test(CredentialStore(context, namespace), File(context.noBackupFilesDir, namespace))
        } finally {
            cleanup(namespace)
        }
    }

    @Test fun encryptedRoundTripAndIndependentLogout() = withStore("roundtrip") { store, dir ->
        assertNull(store.read(netease))
        store.write(netease, fixture)
        store.write(qq, "$fixture-qq")
        assertEquals(fixture, store.read(netease))
        assertFalse(File(dir, "$netease.enc").readText().contains(fixture))
        val first = File(dir, "$netease.enc").readBytes()
        store.write(netease, fixture)
        assertFalse(first.contentEquals(File(dir, "$netease.enc").readBytes()))
        store.remove(netease)
        store.remove(netease)
        assertNull(store.read(netease))
        assertEquals("$fixture-qq", store.read(qq))
        store.write(netease, fixture)
        store.remove(qq)
        assertNull(store.read(qq))
        assertEquals(fixture, store.read(netease))
    }

    @Test fun tamperFailsWithoutErasingRecord() = withStore("tamper") { store, dir ->
        store.write(netease, fixture)
        val file = File(dir, "$netease.enc")
        val bytes = file.readBytes().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        file.writeBytes(bytes)
        assertThrows(Exception::class.java) { store.read(netease) }
        assertArrayEquals(bytes, file.readBytes())
        store.write(netease, "fresh-fixture")
        assertEquals("fresh-fixture", store.read(netease))
    }

    @Test fun providerSwapFailsAuthentication() = withStore("swap") { store, dir ->
        store.write(netease, fixture)
        File(dir, "$netease.enc").copyTo(File(dir, "$qq.enc"))
        assertThrows(Exception::class.java) { store.read(qq) }
        assertEquals(fixture, store.read(netease))
    }

    @Test fun failedWriteRetainsPreviousRecord() = withStore("failed-write") { store, dir ->
        store.write(netease, fixture)
        val before = File(dir, "$netease.enc").readBytes()
        assertThrows(Exception::class.java) { store.write(netease, "x".repeat(1024 * 1024)) }
        assertArrayEquals(before, File(dir, "$netease.enc").readBytes())
        assertEquals(fixture, store.read(netease))
        assertThrows(Exception::class.java) { store.write("../invalid", fixture) }
    }

    @Test fun missingKeyDoesNotEraseOrRegenerateOnRead() = withStore("missing-key") { store, dir ->
        store.write(netease, fixture)
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        keys.deleteEntry("com.ting.music.demo.credential-test-missing-key")
        assertThrows(Exception::class.java) { store.read(netease) }
        assertTrue(File(dir, "$netease.enc").exists())
        assertFalse(keys.containsAlias("com.ting.music.demo.credential-test-missing-key"))
        store.remove(netease)
        assertNull(store.read(netease))
    }

    // Run these two methods in separate `am instrument` processes, in this order.
    @Test fun seedAcrossProcess() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("phase") == "seed")
        cleanup("credential-test-process")
        val store = CredentialStore(context, "credential-test-process")
        store.write(netease, fixture)
        store.write(qq, "$fixture-qq")
        File(context.noBackupFilesDir, "credential-test-process/pid")
            .writeText(android.os.Process.myPid().toString())
    }

    @Test fun restoreAcrossProcess() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("phase") == "restore")
        val namespace = "credential-test-process"
        try {
            val previousPid = File(context.noBackupFilesDir, "$namespace/pid").readText().toInt()
            assertNotEquals(previousPid, android.os.Process.myPid())
            val store = CredentialStore(context, namespace)
            assertEquals(fixture, store.read(netease))
            assertEquals("$fixture-qq", store.read(qq))
            store.remove(netease)
            assertEquals("$fixture-qq", store.read(qq))
        } finally {
            cleanup(namespace)
        }
    }
}
