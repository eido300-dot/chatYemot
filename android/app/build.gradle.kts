import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// גרסה מתג git: -PappVersion=1.2.3  → versionCode = 1*10000 + 2*100 + 3
val appVersion = (project.findProperty("appVersion") as String?) ?: "0.1.0"
val vParts = appVersion.split(".").map { it.toIntOrNull() ?: 0 } + listOf(0, 0, 0)
val computedVersionCode = vParts[0] * 10000 + vParts[1] * 100 + vParts[2]

fun prop(name: String) = project.findProperty(name) as String

android {
    namespace = "il.co.stamandsefer.chatyemot"
    compileSdk = 34

    defaultConfig {
        applicationId = "il.co.stamandsefer.chatyemot"
        minSdk = 24
        targetSdk = 34
        versionCode = computedVersionCode
        versionName = appVersion
        buildConfigField("String", "SERVER_URL", "\"${prop("serverUrl")}\"")
        buildConfigField("String", "GITHUB_REPO", "\"${prop("githubRepo")}\"")
        // אופציונלי: טוקן קריאה בלבד לריפו פרטי (fine-grained, הרשאת Contents:read)
        buildConfigField("String", "GITHUB_TOKEN", "\"${(project.findProperty("githubToken") as String?) ?: ""}\"")
    }

    buildFeatures { buildConfig = true }

    signingConfigs {
        create("release") {
            val ks = System.getenv("KEYSTORE_FILE")
            if (ks != null) {
                storeFile = file(ks)
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KEY_ALIAS")
                keyPassword = System.getenv("KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (System.getenv("KEYSTORE_FILE") != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation(platform("com.google.firebase:firebase-bom:33.1.2"))
    implementation("com.google.firebase:firebase-messaging")
}

// מופעל רק כשקיים google-services.json (ללא הקובץ האפליקציה נבנית בלי FCM)
if (file("google-services.json").exists()) apply(plugin = "com.google.gms.google-services")
