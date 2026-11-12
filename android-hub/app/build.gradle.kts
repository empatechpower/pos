plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.rezein.hub"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.rezein.hub"
        minSdk = 26
        // Stay on 34: from 35 Android limits "data sync" background services to 6 hours a day. Moving to the Play Store
        // later means moving to 35 and switching the service type (see README).
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
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
