import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.rezein.hub"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.rezein.hub"
        minSdk = 26
        // 35, as the Play Store now requires. The background service is declared "specialUse" for that reason: from 35 Android
        // limits "dataSync" services to 6 hours a day.
        targetSdk = 36
        versionCode = 4
        versionName = "0.1.3"
    }

    // The key the Play Store build is signed with. Kept in keystore.properties and keystore/ (never committed).
    val keystoreFile = rootProject.file("keystore.properties")
    val keystoreProps = Properties()
    if (keystoreFile.exists()) keystoreFile.inputStream().use { keystoreProps.load(it) }
    signingConfigs {
        if (keystoreFile.exists()) {
            create("store") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildFeatures { buildConfig = true }

    buildTypes {
        // `./gradlew bundleStore` makes the file for the Play Store (an .aab signed with the upload key).
        if (keystoreFile.exists()) {
            create("store") {
                initWith(getByName("release"))
                signingConfig = signingConfigs.getByName("store")
                matchingFallbacks += "release"
                // No sign-in by text in the Play build (the manifest in src/store removes the permission and receivers).
                buildConfigField("boolean", "SMS_SIGNIN", "false")
            }
        }
        debug {
            buildConfigField("boolean", "SMS_SIGNIN", "true")
        }
        release {
            buildConfigField("boolean", "SMS_SIGNIN", "true")
            isMinifyEnabled = false
            // Signed with the standard test key so the file can be sent to a tablet and installed directly. A store build
            // needs a real signing key instead.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
