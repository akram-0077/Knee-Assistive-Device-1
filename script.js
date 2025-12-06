

  <script>
    function toggleRehabNameDateColumns(show) {
      const table = document.getElementById('rehab-data-table').closest('.table');
      if (show) {
        table.classList.remove('rehab-table-hide-name-date');
      } else {
        table.classList.add('rehab-table-hide-name-date');
      }
    }
    // ====================================================================
    // Firebase Config
    // ====================================================================
    const firebaseConfig = {
      apiKey: "AIzaSyAXJgomjzqs4uqhcmFlsuK84w6fZ4g4LqM", // Using the same API key as ESP32
      authDomain: "knee-assistive-device.firebaseapp.com",
      databaseURL: "https://knee-assistive-device-default-rtdb.firebaseio.com",
      projectId: "knee-assistive-device",
      storageBucket: "knee-assistive-device.appspot.com",
      messagingSenderId: "16560352596",
      appId: "1:16560352596:web:4f3bef65ddd886afa42cc1"
    };


    // Initialize Firebase connection status variable
    let firebaseConnected = false;

    firebase.initializeApp(firebaseConfig);
    const database = firebase.database();

    // Test Firebase connection on load
    database.ref('.info/connected').on('value', (snapshot) => {
      if (snapshot.val() === true) {
        console.log('✅ Firebase connected successfully!');
        updateConnectionStatus(true, 'Firebase Ready');
      } else {
        console.log('❌ Firebase connection lost');
        updateConnectionStatus(false, 'Firebase Offline');
      }
    });

    // ====================================================================
    // Variabel Global
    // ====================================================================
    let sessionTime = 0;
    let currentSessionData = [];
    let allRehabData = [];
    let selectedPatient = null;

    // Variabel State Sesi (DIPERBAIKI)
    let isSessionActive = false; // Menandakan sesi sedang berlangsung (baik itu running atau paused)
    let isPaused = false;        // Menandakan sesi sedang di-jeda

    let sessionInterval;
    let peakGrade = null;
    let lastValidClassification = null;
    // =============================================================================
    // CENTRALIZED CONSTANTS - ADJUST THESE VALUES AS NEEDED
    // =============================================================================
    const EMG_CONSTANTS = {
      // MVC Reference Settings
      DEFAULT_MVC_REFERENCE: 1000,        // Default MVC reference in mV (realistic for EMG)
      MIN_MVC_REFERENCE: 10,              // Minimum valid MVC reference
      MAX_MVC_REFERENCE: 10000,           // Maximum valid MVC reference

      // EMG Display Limits
      MAX_EMG_PERCENTAGE: 200,            // Maximum %MVC to display (200%)
      MIN_EMG_PERCENTAGE: 0,              // Minimum %MVC to display

      // EMG Signal Ranges (typical values)
      TYPICAL_EMG_MIN: 50,                // Typical minimum EMG signal (mV)
      TYPICAL_EMG_MAX: 2000,              // Typical maximum EMG signal (mV)

      // Calibration Settings
      CALIBRATION_DURATION: 5,            // Calibration duration in seconds
      CALIBRATION_SAMPLING_RATE: 10,      // Sampling rate for calibration

      // Safety Thresholds
      EMG_SAFETY_THRESHOLD: 200,          // EMG safety threshold (%MVC)
      ROM_MIN_ANGLE: 0,                   // Minimum knee angle
      ROM_MAX_ANGLE: 180,                 // Maximum knee angle
    };

    // Global variables using constants
    let currentMVCReference = EMG_CONSTANTS.DEFAULT_MVC_REFERENCE;
    let isViewOnlyMode = false;
    let avgAngle = 0;
    let avgRMSEMG = 0;
    let avgMAVEMG = 0;
    let maxRMSEMG = 0;

    // =============================================================================
    // CALCULATION HELPER FUNCTIONS - USE THESE FOR CONSISTENT CALCULATIONS
    // =============================================================================

    /**
     * Get safe MVC reference value
     * @param {number} mvcRef - MVC reference value to validate
     * @returns {number} - Safe MVC reference value
     */
    function getSafeMVCReference(mvcRef) {
      if (mvcRef && mvcRef >= EMG_CONSTANTS.MIN_MVC_REFERENCE && mvcRef <= EMG_CONSTANTS.MAX_MVC_REFERENCE) {
        return mvcRef;
      }
      return EMG_CONSTANTS.DEFAULT_MVC_REFERENCE;
    }

    /**
     * Convert raw EMG value to %MVC
     * @param {number} rawEMG - Raw EMG value in mV
     * @param {number} mvcReference - MVC reference value in mV
     * @returns {number} - %MVC value (0-200%)
     */
    function convertEMGToPercentage(rawEMG, mvcReference = currentMVCReference) {
      const safeMVC = getSafeMVCReference(mvcReference);
      const percentage = (rawEMG / safeMVC) * 100;
      return Math.min(Math.max(percentage, EMG_CONSTANTS.MIN_EMG_PERCENTAGE), EMG_CONSTANTS.MAX_EMG_PERCENTAGE);
    }

    /**
     * Convert %MVC back to raw EMG value
     * @param {number} percentageMVC - %MVC value
     * @param {number} mvcReference - MVC reference value in mV
     * @returns {number} - Raw EMG value in mV
     */
    function convertPercentageToEMG(percentageMVC, mvcReference = currentMVCReference) {
      const safeMVC = getSafeMVCReference(mvcReference);
      return (percentageMVC * safeMVC) / 100;
    }

    /**
     * Format EMG display value with proper units
     * @param {number} value - EMG value
     * @param {string} type - 'raw' for mV, 'percentage' for %
     * @returns {string} - Formatted string with units
     */
    function formatEMGDisplay(value, type = 'raw') {
      if (type === 'raw') {
        return `${value.toFixed(1)} mV`;
      } else if (type === 'percentage') {
        return `${Math.min(value, EMG_CONSTANTS.MAX_EMG_PERCENTAGE).toFixed(1)}%`;
      }
      return value.toFixed(1);
    }

    let romAnalysisData = {
      currentAngle: 0,
      angles: [],
      maxFlexion: 0,
      maxExtension: 0,
      totalROM: 0,
      consistency: 0
    };

    // Initialize chart variables globally
    let angleChart = null;
    let emgChart = null;

    // Variabel Firebase & Debug
    let firebaseRealtimeListener = null;
    let lastDataTimestamp = 0;

    // ====================================================================
    // FUNGSI INTI SESI (DIPERBAIKI)
    // ====================================================================

    /**
     * @description Mengontrol state Mulai, Jeda, dan Lanjutkan Sesi.
     * TIDAK lagi memanggil endSession() secara langsung.
     */
    function toggleSession() {
      if (!selectedPatient) {
        alert('Pilih pasien terlebih dahulu!');
        return;
      }

      if (isViewOnlyMode) {
        alert('Anda sedang dalam mode lihat data. Mulai sesi baru terlebih dahulu!');
        return;
      }

      const sessionBtn = document.getElementById('session-btn');
      const endSessionBtn = document.getElementById('end-session-btn');

      // Jika belum ada sesi yang aktif, maka MULAI SESI BARU
      if (!isSessionActive) {
        isSessionActive = true;
        isPaused = false;

        // Reset data sesi sebelumnya
        currentSessionData = [];
        lastValidClassification = null;
        sessionTime = 0;
        peakGrade = null;

        // Update UI
        sessionBtn.innerHTML = '<i class="fas fa-pause"></i> Jeda Sesi';
        sessionBtn.className = 'btn-warning'; // Warna oranye untuk jeda
        endSessionBtn.disabled = false;
        endSessionBtn.className = 'btn-danger';

        // Tentukan sesi ke-berapa (ambil dari data rehab terakhir pasien) lalu mulai timer & listener
        try {
          const name = selectedPatient.name;
          const today = new Date().toISOString().split('T')[0];

          const getMaxFromRef = (refPath) => database.ref(refPath).orderByChild('name').equalTo(name).once('value').then(snap => {
            let maxS = 0;
            if (snap.exists()) {
              snap.forEach(child => {
                const s = Number(child.val().rehabSession) || 0;
                if (s > maxS) maxS = s;
              });
            }
            return maxS;
          });

          // Basis nextSession = jumlah data rehabilitasi (lebih tahan terhadap nilai rehabSession yang salah)
          database.ref('rehabilitation').orderByChild('name').equalTo(name).once('value').then((snap) => {
            const count = snap && snap.exists() ? snap.numChildren() : 0;
            const nextSession = count + 1;
            selectedPatient.rehabSession = nextSession;
            selectedPatient.date = today;
            updatePatientInfoBar();

            // Mulai timer dan listener data setelah sesi ditentukan
            startTimer();
            initializeFirebaseRealtimeListener();
            sendSessionControlToESP32(true);
            // Popup konfirmasi hanya saat tombol mulai sesi
            const now = new Date();
            alert(`✅ Sesi ke-${nextSession} berhasil dimulai untuk pasien ${name}!\nTanggal: ${now.toLocaleDateString('id-ID')}\nWaktu: ${now.toLocaleTimeString('id-ID')}`);
            console.log(`[Session] Started successfully with session #${nextSession}`);
          }).catch(() => {
            selectedPatient.rehabSession = (Number(selectedPatient.rehabSession) || 0) + 1;
            selectedPatient.date = today;
            updatePatientInfoBar();
            startTimer();
            initializeFirebaseRealtimeListener();
            sendSessionControlToESP32(true);
            alert(`✅ Sesi ke-${selectedPatient.rehabSession} berhasil dimulai untuk pasien ${name}!`);
            console.warn('[Session] Started with fallback session number');
          });
        } catch (e) {
          const today = new Date().toISOString().split('T')[0];
          selectedPatient.rehabSession = (Number(selectedPatient.rehabSession) || 0) + 1;
          selectedPatient.date = today;
          updatePatientInfoBar();
          startTimer();
          initializeFirebaseRealtimeListener();
          sendSessionControlToESP32(true);
          alert(`✅ Sesi ke-${selectedPatient.rehabSession} berhasil dimulai untuk pasien ${selectedPatient.name}!`);
          console.warn('[Session] Started with fallback due to exception');
        }

      } else {
        // Jika sesi sudah aktif, cek apakah mau JEDA atau LANJUTKAN
        isPaused = !isPaused; // Toggle status jeda

        if (isPaused) {
          // JEDA SESI
          clearInterval(sessionInterval);
          stopFirebaseRealtimeListener(); // Beritahu ESP32 untuk berhenti kirim data
          sendSessionControlToESP32(false); // Stop ESP32 session

          sessionBtn.innerHTML = '<i class="fas fa-play"></i> Lanjutkan Sesi';
          sessionBtn.className = 'btn-success';

          console.log('[Session] Paused');
        } else {
          // LANJUTKAN SESI
          startTimer();
          initializeFirebaseRealtimeListener(); // Beritahu ESP32 untuk mulai kirim data lagi
          sendSessionControlToESP32(true); // Restart ESP32 session

          sessionBtn.innerHTML = '<i class="fas fa-pause"></i> Jeda Sesi';
          sessionBtn.className = 'btn-warning';

          console.log('[Session] Resumed');
        }
      }
    }

    /**
     * @description Mengakhiri sesi, menyimpan data ke database, dan mereset state.
     * Hanya dipanggil oleh tombol "Akhiri Sesi".
     */
    // KODE BARU di fungsi endSession() - GANTI DARI BARIS 1227-1260
    /**
    * @description Mengakhiri sesi, menyimpan data ke database, dan mereset state.
    * Hanya dipanggil oleh tombol "Akhiri Sesi".
    */
    function endSession() {
      // 1. Pengecekan awal, apakah ada sesi yang aktif.
      if (!isSessionActive) {
        alert("⚠️ Tidak ada sesi yang sedang berjalan.");
        return;
      }

      // 2. Hentikan semua proses yang berjalan.
      clearInterval(sessionInterval);
      sessionInterval = null;
      sendSessionControlToESP32(false); // Kirim perintah berhenti ke ESP32.

      // 3. Proses dan simpan data HANYA jika ada data yang terekam.
      if (selectedPatient && currentSessionData.length > 0) {
        console.log('[Session] Mengakhiri dan menyimpan data...');

        // Ambil semua nilai RMS EMG dari sesi ini.
        const rmsValues = currentSessionData.map(d => d.rawRMSEMG || 0);
        const avgRMSEMG = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;

        // Ambil semua nilai sudut dari sesi ini.
        const angles = currentSessionData.map(d => d.kneeAngle);
        const avgAngleCalc = angles.reduce((a, b) => a + b, 0) / angles.length;

        // Ambil referensi MVC yang sedang digunakan.
        const mvcReference = currentMVCReference;

        // Hitung persentase MVC untuk klasifikasi.
        const percentMVCForClassification = (avgRMSEMG / mvcReference) * 100;
        const emgFeaturesInMVC = { rms: percentMVCForClassification };

        // Siapkan data ROM untuk klasifikasi.
        const romStats = {
          totalROM: romAnalysisData.maxFlexion,
          maxFlexion: romAnalysisData.maxFlexion,
          maxExtension: romAnalysisData.maxExtension,
          consistency: romAnalysisData.consistency
        };

        // Lakukan klasifikasi akhir berdasarkan data sesi.
        const classification = classifyRehabilitationPerformanceMVC(emgFeaturesInMVC, romStats, mvcReference);

        // Siapkan objek data lengkap untuk disimpan ke Firebase.
        const rehabData = {
          name: selectedPatient.name,
          age: selectedPatient.age,
          date: selectedPatient.date,
          rehabSession: selectedPatient.rehabSession,
          avgAngle: avgAngleCalc,
          maxAngle: Math.max(...angles),
          minAngle: Math.min(...angles),
          totalROM: romAnalysisData.totalROM,
          maxFlexion: romAnalysisData.maxFlexion,
          maxExtension: romAnalysisData.maxExtension,
          romConsistency: romStats.consistency,
          mvcReference: mvcReference,
          avgRMSEMG: avgRMSEMG, // Simpan nilai RMS mentah (mV).
          mvcReference: mvcReference,
          emgUnit: 'mV',
          grade: classification.romGrade, // Menggunakan grade ROM sebagai grade utama
          status: `ROM: ${classification.romGrade} | EMG: ${classification.emgGrade}`,
          sessionDuration: sessionTime,
          dataPointsCount: currentSessionData.length,
          timestamp: new Date().toISOString()
        };

        // Kirim data ke Firebase.
        database.ref('rehabilitation').push(rehabData).then(() => {
          alert(`✅ Sesi untuk ${selectedPatient.name} telah berhasil disimpan!`);
          loadFilteredData(); // Muat ulang data di tabel.
          currentSessionData = []; // Kosongkan data sesi sementara.
        }).catch(error => {
          console.error("Gagal menyimpan data sesi:", error);
          alert("❌ Terjadi kesalahan saat menyimpan data sesi.");
        });

      } else {
        // Jika tidak ada data yang terekam, cukup berikan peringatan.
        alert("⚠️ Tidak ada data sesi yang terekam untuk disimpan.");
      }

      // 4. Reset semua tampilan UI ke kondisi awal.
      document.getElementById('session-time').textContent = '00:00:00';

      const sessionBtn = document.getElementById('session-btn');
      sessionBtn.innerHTML = '<i class="fas fa-play"></i> Mulai Sesi';
      sessionBtn.className = 'btn-success';

      const endSessionBtn = document.getElementById('end-session-btn');
      endSessionBtn.disabled = true;
      endSessionBtn.className = 'btn-danger opacity-50';

      clearSessionData();

      // 5. KUNCI PERBAIKAN: Ubah state sesi menjadi tidak aktif HANYA setelah semua proses di atas selesai.
      isSessionActive = false;
      isPaused = false;
      console.log('[Session] Sesi telah diakhiri dan state direset.');
    }

    /**
     * @description Helper function untuk memulai timer sesi.
     */
    function startTimer() {
      sessionInterval = setInterval(() => {
        sessionTime++;
        const h = String(Math.floor(sessionTime / 3600)).padStart(2, '0');
        const m = String(Math.floor((sessionTime % 3600) / 60)).padStart(2, '0');
        const s = String(sessionTime % 60).padStart(2, '0');
        document.getElementById('session-time').textContent = `${h}:${m}:${s}`;
      }, 1000);
    }



    // ====================================================================
    // FUNGSI KOMUNIKASI FIREBASE (DIPERBAIKI)
    // ====================================================================
    function initializeFirebaseRealtimeListener() {
      if (!selectedPatient) return;

      console.log('[Firebase] Starting FIXED real-time listener...');

      // Hapus listener lama jika ada
      if (firebaseRealtimeListener) {
        database.ref('realtime_sensor_data').off('value', firebaseRealtimeListener);
        firebaseRealtimeListener = null;
      }

      const realtimeDataRef = database.ref('realtime_sensor_data');

      firebaseRealtimeListener = realtimeDataRef.on('value', (snapshot) => {
        const data = snapshot.val();
        console.log('[Firebase] Data received:', data);

        if (data) {
          // Check for direct flat structure FIRST (new FIXED format)
          if (data.kneeAngle !== undefined && data.rmsEMG !== undefined) {
            console.log('[Firebase] ✅ Processing direct flat data structure (FIXED format)');
            updateDebugInfo('Data received (flat structure)', data);
            processFirebaseRealtimeDataFixed(data);
          } else {
            // Fallback: handle timestamp-keyed nested structure (old format)
            const timestamps = Object.keys(data).filter(key => !isNaN(key)); // Only numeric timestamp keys
            if (timestamps.length > 0) {
              const latestTimestamp = timestamps.sort((a, b) => parseInt(b) - parseInt(a))[0]; // Get latest timestamp
              const latestData = data[latestTimestamp];

              console.log('[Firebase] 📦 Processing nested data structure (legacy format), latest:', latestData);

              if (latestData && latestData.kneeAngle !== undefined && latestData.rmsEMG !== undefined) {
                updateDebugInfo('Data received (nested structure)', latestData);
                processFirebaseRealtimeDataFixed(latestData);
              } else {
                console.warn('[Firebase] ⚠️ Data structure not recognized:', data);
                updateDebugInfo('Waiting for valid data...', { structure: 'unknown', keys: Object.keys(data) });
              }
            } else {
              console.warn('[Firebase] ⚠️ No valid data found:', data);
              updateDebugInfo('No sensor data available', { received: Object.keys(data) });
            }
          }
        } else {
          updateDebugInfo('No data received', null);
        }
      }, (error) => {
        console.error('[Firebase] Listener error:', error);
        updateDebugInfo('Connection error', { error: error.message });
      });

      // Monitor koneksi
      database.ref('.info/connected').on('value', (snapshot) => {
        const connected = snapshot.val();
        updateConnectionStatus(connected, connected ? 'Firebase Connected' : 'Firebase Disconnected');
      });

      // Don't automatically start session - let user control it
      console.log('[Firebase] Real-time listener initialized. Session will be started manually.');
    }

    function processFirebaseRealtimeDataFixed(data) {
      try {
        console.log('[Process] Processing data:', data);

        // Check if this is diagnostic data (not actual sensor data)
        if (data.deviceStatus === "online" && data.adcValue === 0 && data.emgVoltage === 0) {
          console.log('[Process] Received diagnostic data, waiting for actual sensor data...');
          updateDebugInfo('Device online, waiting for sensor data', data);
          return; // Skip processing diagnostic data
        }

        const timestamp = data.timestamp || Date.now();
        const kneeAngle = parseFloat(data.kneeAngle) || 0;
        const rawRMSEMG = parseFloat(data.rmsEMG) || 0;
        const rawMAVEMG = parseFloat(data.mavEMG) || 0;

        // Only process if we have valid sensor data
        // Update max RMS jika nilai baru lebih tinggi
        if (rawRMSEMG > maxRMSEMG) {
          maxRMSEMG = rawRMSEMG;
          const maxRMSElement = document.getElementById('max-rms');
          if (maxRMSElement) {
            maxRMSElement.textContent = maxRMSEMG.toFixed(2) + ' mV';
          }
          console.log('[Process] New max RMS:', maxRMSEMG.toFixed(2), 'mV');
        }

        // Get safe MVC reference using helper function
        const safeMVCReference = getSafeMVCReference(data.mvcReference || currentMVCReference);

        // Calculate proper %MVC using helper function
        const rmsPercentMVC = convertEMGToPercentage(rawRMSEMG, safeMVCReference);
        const mavPercentMVC = convertEMGToPercentage(rawMAVEMG, safeMVCReference);

        const processedData = {
          timestamp,
          kneeAngle,
          rawRMSEMG,
          rawMAVEMG,
          rmsEMG: rmsPercentMVC,
          mvcReference: safeMVCReference,
        };

        // Selalu tambahkan ke session data
        currentSessionData.push(processedData);
        if (currentSessionData.length > 100) {
          currentSessionData.shift();
        }

        // Update ROM analysis
        const anglesHistory = currentSessionData.map(d => d.kneeAngle);
        updateROMAnalysis(kneeAngle, anglesHistory);

        // SELALU update charts dan display
        updateChartsRealTimeFixed(processedData);
        updateConnectionStatus(true, `Data: ${kneeAngle.toFixed(1)}°`);

        // Update EMG calibration displays
        updateMVCReference(safeMVCReference);
        updateMVCPercentage(rmsPercentMVC);
        updateRMSEMG(rawRMSEMG);

        // Update safety system
        const safetyData = {
          ...processedData,
          pressure: data.pressure || 25, // Default pressure if not provided
          percentMVC: rmsPercentMVC
        };
        updateSafetySystem(safetyData);

        lastDataTimestamp = timestamp;

        console.log('[Process] Success - Angle:', kneeAngle, 'RMS:', rmsPercentMVC);

      } catch (error) {
        console.error('[Process] Error:', error);
      }
    }


    function stopFirebaseRealtimeListener() {
      console.log('[Firebase] Stopping real-time listener...');
      sendSessionControlToESP32(false);

      if (firebaseRealtimeListener) {
        database.ref('realtime_sensor_data').off();
        firebaseRealtimeListener = null;
      }
      database.ref('.info/connected').off();
      updateConnectionStatus(false, 'Listener stopped');
    }

    function sendSessionControlToESP32(sessionActive) {
      if (!selectedPatient) return;

      const controlData = {
        command: sessionActive ? 'START_SESSION' : 'STOP_SESSION',
        sessionActive: sessionActive,
        patientInfo: {
          id: selectedPatient.name.replace(/\s+/g, '_'),
          name: selectedPatient.name,
          sessionNumber: selectedPatient.rehabSession
        },
        sessionSettings: {
          samplingRate: EMG_CONSTANTS.CALIBRATION_SAMPLING_RATE,
          mvcReference: currentMVCReference
        },
        timestamp: Date.now(),
        source: 'web_app'
      };

      database.ref('session_control').set(controlData)
        .then(() => console.log(`[Firebase] Session control sent: ${controlData.command}`))
        .catch(error => console.error('[Firebase] Error sending session control:', error));
    }

    function updateDebugInfo(status, data) {
      const debugElement = document.getElementById('debug-info');
      if (debugElement) {
        const timestamp = new Date().toLocaleTimeString();
        debugElement.innerHTML = `
        <div class="text-xs text-slate-400">
          <div>Last Update: ${timestamp}</div>
          <div>Status: ${status}</div>
          <div>Data: ${JSON.stringify(data, null, 2).substring(0, 200)}...</div>
        </div>
      `;
      }
    }

    function updateConnectionStatus(connected, message = '') {
      const statusElement = document.getElementById('thingspeak-status');
      if (!statusElement) return;

      firebaseConnected = connected;

      if (connected) {
        statusElement.className = 'status-indicator running';
        statusElement.innerHTML = `<i class="fas fa-circle mr-2"></i>Firebase Connected`;
      } else {
        statusElement.className = 'status-indicator stopped';
        statusElement.innerHTML = `<i class="fas fa-circle mr-2"></i>Firebase Disconnected`;
      }
      if (message) {
        statusElement.innerHTML += `<br><small>${message}</small>`;
      }
    }


    // ====================================================================
    // SISA FUNGSI (TIDAK ADA PERUBAHAN SIGNIFIKAN, HANYA PENYESUAIAN)
    // ====================================================================
    function updateChartsRealTimeFixed(newData) {
      console.log('[Charts] Updating charts with:', newData);

      // Initialize charts if they don't exist
      if (!angleChart || !emgChart) {
        console.warn('[Charts] Charts not initialized, creating them now...');
        createChartInstances();
        if (!angleChart || !emgChart) {
          console.error('[Charts] Failed to create charts, skipping update');
          return;
        }
      }

      const currentTime = new Date(newData.timestamp).toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      // Ensure data is valid before adding
      const kneeAngle = isNaN(newData.kneeAngle) ? 0 : newData.kneeAngle;
      const rmsEMG = isNaN(newData.rmsEMG) ? 0 : newData.rmsEMG;

      try {
        // Update angle chart
        angleChart.data.labels.push(currentTime);
        angleChart.data.datasets[0].data.push(kneeAngle);

        // Keep only last 20 data points
        if (angleChart.data.labels.length > 20) {
          angleChart.data.labels.shift();
          angleChart.data.datasets[0].data.shift();
        }

        angleChart.update('none');
        console.log('[Charts] Angle chart updated. Last angle:', kneeAngle);

        // Update EMG chart
        emgChart.data.labels.push(currentTime);
        emgChart.data.datasets[0].data.push(rmsEMG); // RMS EMG

        // Keep only last 20 data points
        if (emgChart.data.labels.length > 20) {
          emgChart.data.labels.shift();
          emgChart.data.datasets[0].data.shift();
        }

        emgChart.update('none');
        console.log('[Charts] EMG chart updated. Last RMS:', rmsEMG);

        // Update display values with proper error handling
        const angleElement = document.getElementById('average-angle');
        const rmsElement = document.getElementById('average-rms-emg');

        if (angleElement) angleElement.textContent = kneeAngle.toFixed(2) + '°';
        if (rmsElement) rmsElement.textContent = rmsEMG.toFixed(2) + ' mV';


        const romTotalElement = document.getElementById('current-rom-total');
        if (romTotalElement) {
          romTotalElement.textContent = romAnalysisData.totalROM.toFixed(1) + '°';
        }

        console.log('[Charts] Display values updated successfully');

      } catch (error) {
        console.error('[Charts] Error updating charts:', error);
      }

      try {
        const currentRomElement = document.getElementById('display-current-rom');
        const totalRomElement = document.getElementById('display-total-rom');

        // ROM Saat Ini (realtime)
        if (currentRomElement && typeof kneeAngle === "number") {
          currentRomElement.textContent = `${kneeAngle.toFixed(1)}°`;
        }

        // ROM Total
        if (totalRomElement && typeof romAnalysisData.maxFlexion === "number") {
          totalRomElement.textContent = `0° - ${romAnalysisData.maxFlexion.toFixed(1)}°`;
        }
      } catch (error) {
        console.warn('[Charts] Error updating ROM displays:', error);
      }



      const emgFeaturesInMVC = { rms: newData.rmsEMG };

      // Perbaikan Utama: Gunakan kneeAngle terbaru sebagai fallback untuk maxFlexion
      const currentMaxFlexion = romAnalysisData.maxFlexion || 0;
      const safeMaxFlexion = currentMaxFlexion > 0 ? currentMaxFlexion : newData.kneeAngle;

      const romStats = {
        totalROM: safeMaxFlexion, // <-- Gunakan safeMaxFlexion untuk perhitungan
        maxFlexion: safeMaxFlexion, // <-- Juga perbarui maxFlexion
        maxExtension: romAnalysisData.maxExtension,
        consistency: romAnalysisData.consistency
      };

      const classification = classifyRehabilitationPerformanceMVC(emgFeaturesInMVC, romStats, currentMVCReference);

      // SIMPAN KLASIFIKASI INI SEBAGAI YANG TERAKHIR
      lastValidClassification = classification;
      updateClassificationDisplay(classification);
      updateRealtimeFeatureDisplayMVC(emgFeaturesInMVC, newData);

      // Update global variables
      avgAngle = newData.kneeAngle;
      avgRMSEMG = newData.rmsEMG;

      console.log('[Charts] Updated - Angle:', newData.kneeAngle, 'RMS:', newData.rmsEMG);
    }
    function updateROMAnalysis(currentAngle, anglesHistory) {
      romAnalysisData.currentAngle = currentAngle;
      romAnalysisData.angles = anglesHistory.slice(-50);

      if (romAnalysisData.angles.length > 0) {
        const maxAngleInSession = Math.max(...romAnalysisData.angles);
        const minAngleInSession = Math.min(...romAnalysisData.angles);

        // Sistem lutut standar: 0° = ekstensi (lurus), positif = fleksi (tekuk)
        romAnalysisData.maxFlexion = maxAngleInSession;     // Sudut tertinggi
        romAnalysisData.maxExtension = minAngleInSession;   // Sudut terendah

        // Total ROM untuk kompatibilitas (tidak digunakan untuk tampilan)
        romAnalysisData.totalROM = maxAngleInSession - minAngleInSession;

        console.log(`[ROM] Fleksi: ${romAnalysisData.maxFlexion}°, Ekstensi: ${romAnalysisData.maxExtension}°, Rentang: ${romAnalysisData.maxExtension}-${romAnalysisData.maxFlexion}°`);
      } else {
        Object.assign(romAnalysisData, { maxFlexion: 0, maxExtension: 0, totalROM: 0 });
      }

      // Update ROM display sebagai rentang (ekstensi-fleksi)
      document.getElementById('display-current-rom').textContent = `${currentAngle.toFixed(1)}°`;
      document.getElementById('display-total-rom').textContent = `${romAnalysisData.maxExtension.toFixed(1)}-${romAnalysisData.maxFlexion.toFixed(1)}°`;
      document.getElementById('display-max-flexion').textContent = `${romAnalysisData.maxFlexion.toFixed(1)}°`;
      document.getElementById('display-max-extension').textContent = `${romAnalysisData.maxExtension.toFixed(1)}°`;

      // Update ROM category menggunakan fleksi maksimal
      const romCategory = getROMCategory(romAnalysisData.maxFlexion);
      const categoryIndicator = document.getElementById('rom-category-indicator');
      const categoryText = document.getElementById('rom-category-text');

      if (categoryIndicator && categoryText) {
        categoryIndicator.className = `w-3 h-3 rounded-full mr-2 ${romCategory.color}`;
        categoryText.textContent = `(${romCategory.label})`;
      }
    }
    function getROMCategory(totalROM) {
      if (totalROM >= 120) return { label: 'Excellent', color: 'bg-green-400' };
      if (totalROM >= 100) return { label: 'Good', color: 'bg-blue-400' };
      if (totalROM >= 80) return { label: 'Fair', color: 'bg-yellow-400' };
      if (totalROM >= 60) return { label: 'Poor', color: 'bg-red-400' };
      return { label: 'Standby', color: 'bg-slate-500' };
    }

    function getGradeColor(grade) {
      switch (grade) {
        case 'A': return 'text-green-400';
        case 'B': return 'text-blue-400';
        case 'C': return 'text-yellow-400';
        case 'D': return 'text-red-400';
        default: return 'text-slate-400';
      }
    }

    function classifyRehabilitationPerformanceMVC(emgFeaturesInMVC, romData, mvcReference) {
      // ============ GRADE ROM (TERPISAH) ============
      const totalROM = romData.maxFlexion || romData.totalROM || 0;
      let romGrade, romStatus, romIcon;

      if (totalROM >= 120) {
        romGrade = 'A';
        romStatus = 'Excellent';
        romIcon = '🏆';
      } else if (totalROM >= 100) {
        romGrade = 'B';
        romStatus = 'Good';
        romIcon = '👍';
      } else if (totalROM >= 80) {
        romGrade = 'C';
        romStatus = 'Fair';
        romIcon = '😊';
      } else {
        romGrade = 'D';
        romStatus = 'Poor';
        romIcon = '⚠️';
      }

      // ============ GRADE EMG (TERPISAH) ============
      const emgPercentMVC = emgFeaturesInMVC.rms || 0;
      let emgGrade, emgStatus, emgIcon;

      if (emgPercentMVC >= 60) {
        emgGrade = 'A';
        emgStatus = 'Excellent';
        emgIcon = '🏆';
      } else if (emgPercentMVC >= 45) {
        emgGrade = 'B';
        emgStatus = 'Good';
        emgIcon = '👍';
      } else if (emgPercentMVC >= 30) {
        emgGrade = 'C';
        emgStatus = 'Fair';
        emgIcon = '😊';
      } else {
        emgGrade = 'D';
        emgStatus = 'Poor';
        emgIcon = '⚠️';
      }

      // ============ RETURN 2 GRADE TERPISAH ============
      return {
        // Grade ROM
        romGrade: romGrade,
        romStatus: romStatus,
        romIcon: romIcon,
        romValue: totalROM.toFixed(1),

        // Grade EMG
        emgGrade: emgGrade,
        emgStatus: emgStatus,
        emgIcon: emgIcon,
        emgValue: emgPercentMVC.toFixed(1),

        // Untuk kompatibilitas dengan fungsi lama (opsional)
        grade: romGrade, // fallback ke ROM grade
        status: `ROM: ${romGrade} | EMG: ${emgGrade}`,
        description: `ROM: ${totalROM.toFixed(1)}° (${romGrade}) | EMG: ${emgPercentMVC.toFixed(1)}% (${emgGrade})`,
        icon: `${romIcon}${emgIcon}`
      };
    }
    function showTab(id) {
      // Sembunyikan semua tab
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.getElementById(id).classList.add('active');

      // Sidebar: set active
      document.querySelectorAll('.sidebar-item').forEach(item => item.classList.remove('active'));
      const activeSidebarItem = [...document.querySelectorAll('.sidebar-item')]
        .find(item => item.getAttribute('onclick').includes(`'${id}'`));
      if (activeSidebarItem) activeSidebarItem.classList.add('active');

      // Navbar: set active
      document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
      const activeNavItem = [...document.querySelectorAll('.nav-item')]
        .find(item => item.getAttribute('onclick').includes(`'${id}'`));
      if (activeNavItem) activeNavItem.classList.add('active');

      // Kondisi pasien
      if (selectedPatient) {
        updateTabsForSelectedPatient();
      } else {
        updateTabsForNoPatient();
      }
    }


    // Additional helper functions for data processing and UI updates
    function calculateMuscleCoordination(emgFeatures) {
      const signalQuality = emgFeatures.rms > 0 ?
        Math.min(100, (emgFeatures.rms / (emgFeatures.variance + 0.001)) * 10) : 0;

      const activationPattern = emgFeatures.zeroCrossings > 0 ?
        Math.min(100, emgFeatures.zeroCrossings * 5) : 0;

      return (signalQuality + activationPattern) / 2;
    }

    function refreshDataForSelectedPatient(patientName) {
      return new Promise((resolve) => {
        database.ref('rehabilitation').orderByChild('name').equalTo(patientName).once('value', snapshot => {
          const data = [];
          if (snapshot.exists()) {
            snapshot.forEach(child => {
              data.push(child.val());
            });
          }
          resolve(data);
        }).catch(error => {
          console.error("Error refreshing patient data:", error);
          resolve([]);
        });
      });
    }

    function refreshAllData() {
      return new Promise((resolve) => {
        database.ref('rehabilitation').once('value', snapshot => {
          const data = [];
          if (snapshot.exists()) {
            snapshot.forEach(child => {
              data.push(child.val());
            });
          }
          resolve(data);
        }).catch(error => {
          console.error("Error refreshing all data:", error);
          resolve([]);
        });
      });
    }

    function formatDurationForPDF(seconds) {
      if (!seconds || seconds === 0) return '0 detik';

      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;

      let result = '';
      if (hours > 0) result += `${hours} jam `;
      if (minutes > 0) result += `${minutes} menit `;
      if (secs > 0 && hours === 0) result += `${secs} detik`;

      return result.trim() || '0 detik';
    }



    // Helper function to get the correct MVC reference
    function getCorrectMVCReference(data) {
      // Priority: 1. data.mvcReference, 2. currentMVCReference, 3. default from constants
      return getSafeMVCReference(data.mvcReference || currentMVCReference);
    }

    // Function to get MVC reference for a specific patient
    async function getPatientMVCReference(patientName) {
      try {
        const patientKey = patientName.replace(/\s+/g, '_');
        const snapshot = await database.ref(`mvc_calibration/${patientKey}`).once('value');
        const mvcData = snapshot.val();
        const patientMVC = mvcData && mvcData.maxMVC ? mvcData.maxMVC : currentMVCReference;
        return getSafeMVCReference(patientMVC);
      } catch (error) {
        console.error('Error getting patient MVC reference:', error);
        return getSafeMVCReference(currentMVCReference);
      }
    }

    function editRehabData(firebaseKey, name, session, date, romTotal, flexion, extension, rmsEMG, mvcPercent, mvcRef, duration) {
      console.log('editRehabData called:', {
        firebaseKey, name, session, date, romTotal, flexion, extension, rmsEMG, mvcPercent, mvcRef, duration
      });

      editingRehabKey = firebaseKey;

      // Konversi data dengan aman
      const cleanRomTotal = parseFloat(romTotal) || 0;
      const cleanFlexion = parseFloat(flexion) || 0;
      const cleanExtension = parseFloat(extension) || 0;
      const cleanRmsEMG = parseFloat(rmsEMG) || 0;
      const cleanMvcPercent = parseFloat(mvcPercent) || 0;
      const cleanMvcRef = parseFloat(mvcRef) || EMG_CONSTANTS.DEFAULT_MVC_REFERENCE;
      const cleanDuration = parseInt(duration) || 0;

      console.log('Cleaned values:', {
        romTotal: cleanRomTotal,
        flexion: cleanFlexion,
        extension: cleanExtension,
        rmsEMG: cleanRmsEMG,
        mvcPercent: cleanMvcPercent,
        mvcRef: cleanMvcRef,
        duration: cleanDuration
      });

      // Isi semua field form
      document.getElementById('edit-rehab-name').value = name || '';
      document.getElementById('edit-rehab-session').value = session || '';
      document.getElementById('edit-rehab-date').value = date || '';
      document.getElementById('edit-rehab-duration').value = cleanDuration;
      document.getElementById('edit-rehab-rom-total').value = cleanRomTotal.toFixed(1);
      document.getElementById('edit-rehab-flexion').value = cleanFlexion.toFixed(1);
      document.getElementById('edit-rehab-extension').value = cleanExtension.toFixed(1);
      document.getElementById('edit-rehab-rms-emg').value = cleanRmsEMG.toFixed(2);
      document.getElementById('edit-rehab-mvc-percent').value = cleanMvcPercent.toFixed(1);
      document.getElementById('edit-rehab-mvc-ref').value = cleanMvcRef.toFixed(2);

      // Hitung dan tampilkan grade
      const romPoints = cleanRomTotal >= 120 ? 1.5 : (cleanRomTotal >= 90 ? 1.0 : (cleanRomTotal >= 60 ? 0.5 : 0));
      const emgPoints = cleanMvcPercent >= 60 ? 1.5 : (cleanMvcPercent >= 40 ? 1.0 : (cleanMvcPercent >= 20 ? 0.5 : 0));

      const romGrade = getGradeFromPoints(romPoints);
      const rmsGrade = getGradeFromPoints(emgPoints);

      document.getElementById('edit-rehab-grade-rom').value = `${romGrade.grade} ${romGrade.icon}`;
      document.getElementById('edit-rehab-grade-rms').value = `${rmsGrade.grade} ${rmsGrade.icon}`;

      // Tampilkan modal
      document.getElementById('editRehabModal').style.display = 'block';

      console.log('✅ Modal displayed successfully');
    }
    function closeEditRehabModal() {
      document.getElementById('editRehabModal').style.display = 'none';
      editingRehabKey = null;
    }

    function saveEditedRehabData() {
      if (!editingRehabKey) {
        alert('❌ Tidak ada data yang sedang diedit!');
        return;
      }

      // Ambil semua nilai dari form
      const date = document.getElementById('edit-rehab-date').value;
      const duration = parseInt(document.getElementById('edit-rehab-duration').value) || 0;
      const romTotal = parseFloat(document.getElementById('edit-rehab-rom-total').value) || 0;
      const flexion = parseFloat(document.getElementById('edit-rehab-flexion').value) || 0;
      const extension = parseFloat(document.getElementById('edit-rehab-extension').value) || 0;
      const rmsEMG = parseFloat(document.getElementById('edit-rehab-rms-emg').value) || 0;
      const mvcRef = parseFloat(document.getElementById('edit-rehab-mvc-ref').value) || EMG_CONSTANTS.DEFAULT_MVC_REFERENCE;

      console.log('Saving data:', {
        date, duration, romTotal, flexion, extension, rmsEMG, mvcRef
      });

      // Validasi
      if (!date) {
        alert("⚠️ Tanggal harus diisi!");
        return;
      }

      if (duration < 0 || romTotal < 0 || rmsEMG < 0) {
        alert("⚠️ Nilai tidak boleh negatif!");
        return;
      }

      // Hitung ulang %MVC
      const mvcPercent = convertEMGToPercentage(rmsEMG, mvcRef);

      // Hitung grade
      const romPoints = romTotal >= 120 ? 1.5 : (romTotal >= 90 ? 1.0 : (romTotal >= 60 ? 0.5 : 0));
      const emgPoints = mvcPercent >= 60 ? 1.5 : (mvcPercent >= 40 ? 1.0 : (mvcPercent >= 20 ? 0.5 : 0));

      const romGrade = getGradeFromPoints(romPoints);
      const rmsGrade = getGradeFromPoints(emgPoints);

      console.log('Calculated grades:', {
        romGrade: romGrade.grade,
        rmsGrade: rmsGrade.grade,
        mvcPercent: mvcPercent
      });

      // Update ke Firebase
      database.ref(`rehabilitation/${editingRehabKey}`).update({
        date: date,
        sessionDuration: duration,
        totalROM: romTotal,
        maxFlexion: flexion,
        maxExtension: extension,
        avgRMSEMG: rmsEMG,
        avgAngle: romTotal, // untuk backward compatibility
        mvcReference: mvcRef,
        romGrade: romGrade.grade,
        rmsGrade: rmsGrade.grade,
        updatedAt: new Date().toISOString()
      }).then(() => {
        console.log('✅ Data saved successfully');
        alert("✅ Data rehabilitasi berhasil diperbarui!");
        closeEditRehabModal();

        // Refresh kedua tabel
        if (selectedPatient) {
          loadFilteredData();
        } else {
          loadAllData();
        }
      }).catch(error => {
        console.error("Error updating data:", error);
        alert("❌ Gagal memperbarui data: " + error.message);
      });
    }

    function deleteRehabData(firebaseKey, name, session) {
      const confirmMessage = `⚠️ Apakah Anda yakin ingin menghapus data rehabilitasi?\n\nPasien: ${name}\nSesi: ${session}\n\n⚠️ Tindakan ini tidak dapat dibatalkan!`;

      if (!confirm(confirmMessage)) {
        return;
      }

      database.ref(`rehabilitation/${firebaseKey}`).remove().then(() => {
        alert("✅ Data rehabilitasi berhasil dihapus!");

        database.ref('patients').orderByChild('name').equalTo(name).once('value', patientsSnapshot => {
          if (patientsSnapshot.exists()) {
            patientsSnapshot.forEach(child => {
              const patientData = child.val();
              if (patientData.rehabSession === session) {
                database.ref(`patients/${child.key}`).remove().then(() => {
                  console.log(`Deleted patient session record for ${name} session ${session}`);
                });
              }
            });
          }

          setTimeout(() => {
            updateSessionNumbers(name);
          }, 500);
        });

        if (selectedPatient) {
          loadFilteredData();
        } else {
          loadAllData();
        }

        const existingPatientList = document.getElementById('existing-patient-list');
        if (existingPatientList && existingPatientList.style.display !== 'none') {
          setTimeout(() => {
            loadExistingPatients();
          }, 3000);
        }
      }).catch(error => {
        console.error("Error deleting rehab data:", error);
        alert("❌ Gagal menghapus data. Silakan coba lagi.");
      });
    }

    function updateSessionNumbers(patientName) {
      database.ref('rehabilitation').orderByChild('name').equalTo(patientName).once('value', snapshot => {
        if (!snapshot.exists()) return;

        const patientSessions = [];
        snapshot.forEach(child => {
          patientSessions.push({
            key: child.key,
            data: child.val()
          });
        });

        patientSessions.sort((a, b) => {
          if (a.data.date === b.data.date) {
            return a.data.rehabSession - b.data.rehabSession;
          }
          return new Date(a.data.date) - new Date(b.data.date);
        });

        const updateRehabPromises = patientSessions.map((session, index) => {
          return database.ref(`rehabilitation/${session.key}`).update({
            rehabSession: index + 1
          });
        });

        Promise.all(updateRehabPromises).then(() => {
          console.log(`✅ Rehabilitation session numbers updated for ${patientName}`);

          database.ref('patients').orderByChild('name').equalTo(patientName).once('value', patientsSnapshot => {
            if (!patientsSnapshot.exists()) return;

            const patientRecords = [];
            patientsSnapshot.forEach(child => {
              patientRecords.push({
                key: child.key,
                data: child.val()
              });
            });

            patientRecords.sort((a, b) => {
              if (a.data.date === b.data.date) {
                return a.data.rehabSession - b.data.rehabSession;
              }
              return new Date(a.data.date) - new Date(b.data.date);
            });

            const updatePatientsPromises = patientRecords.map((patient, index) => {
              return database.ref(`patients/${patient.key}`).update({
                rehabSession: index + 1
              });
            });

            Promise.all(updatePatientsPromises).then(() => {
              console.log(`✅ Patients session numbers updated for ${patientName}`);
            });
          });
        });
      });
    }

    function showNewPatientForm() {
      document.getElementById('new-patient-form').style.display = 'block';
      document.getElementById('existing-patient-list').style.display = 'none';
      document.getElementById('edit-patient-form').style.display = 'none';

      const today = new Date();
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      const todayString = `${year}-${month}-${day}`;

      document.getElementById('new-patient-date').value = todayString;
    }

    function showExistingPatientList() {
      document.getElementById('new-patient-form').style.display = 'none';
      document.getElementById('existing-patient-list').style.display = 'block';
      document.getElementById('edit-patient-form').style.display = 'none';
      loadExistingPatients();
    }

    function cancelNewPatient() {
      document.getElementById('new-patient-form').style.display = 'none';
      document.getElementById('edit-patient-form').style.display = 'none';
      clearNewPatientForm();
    }

    function cancelExistingPatient() {
      document.getElementById('existing-patient-list').style.display = 'none';
      document.getElementById('edit-patient-form').style.display = 'none';
    }

    function clearNewPatientForm() {
      document.getElementById('new-patient-name').value = '';
      document.getElementById('new-patient-age').value = '';
      document.getElementById('new-patient-gender').value = '';
      document.getElementById('new-patient-date').value = '';
    }

    // ======================== PATIENT EDITING FUNCTIONS ========================

    let editingPatientKey = null;
    let originalPatientName = null;

    function editPatient(firebaseKey, name, age, gender, weight = null, height = null) {
      editingPatientKey = firebaseKey;
      originalPatientName = name;
      document.getElementById('edit-patient-name').value = name;
      document.getElementById('edit-patient-age').value = age;
      document.getElementById('edit-patient-gender').value = gender || 'Tidak Diketahui';
      document.getElementById('edit-patient-weight').value = weight || '';
      document.getElementById('edit-patient-height').value = height || '';

      database.ref(`patient_registrations/${firebaseKey}`).once('value', snapshot => {
        if (snapshot.exists()) {
          const data = snapshot.val();
          if (data.registrationDate) {
            document.getElementById('edit-patient-date').value = data.registrationDate;
          }
        }
      });

      document.getElementById('edit-patient-form').style.display = 'block';
      document.getElementById('new-patient-form').style.display = 'none';
      document.getElementById('existing-patient-list').style.display = 'none';
    }

    function cancelEditPatient() {
      editingPatientKey = null;
      originalPatientName = null;
      document.getElementById('edit-patient-form').style.display = 'none';
      clearEditPatientForm();
    }

    function clearEditPatientForm() {
      document.getElementById('edit-patient-name').value = '';
      document.getElementById('edit-patient-age').value = '';
      document.getElementById('edit-patient-gender').value = '';
      document.getElementById('edit-patient-date').value = '';
    }

    function updatePatient() {
      if (!editingPatientKey) {
        alert('❌ Tidak ada pasien yang sedang diedit!');
        return;
      }

      const name = document.getElementById('edit-patient-name').value.trim();
      const age = document.getElementById('edit-patient-age').value;
      const gender = document.getElementById('edit-patient-gender').value;
      const date = document.getElementById('edit-patient-date').value;
      const weight = document.getElementById('edit-patient-weight').value;
      const height = document.getElementById('edit-patient-height').value;
      // Validation
      if (!name || !age || !gender || !date) {
        alert('❌ Semua field harus diisi!');
        return;
      }

      const validation = validatePatientData(name, age, date);
      if (!validation.valid) {
        alert('❌ ' + validation.message);
        return;
      }

      // Check if name changed and if new name already exists
      if (name !== originalPatientName) {
        database.ref('patient_registrations').orderByChild('name').equalTo(name).once('value', snapshot => {
          if (snapshot.exists()) {
            alert('❌ Nama pasien sudah digunakan oleh pasien lain!');
            return;
          }
          performPatientUpdate(name, age, gender, date, weight, height);
        });
      } else {
        performPatientUpdate(name, age, gender, date, weight, height);
      }
    }

    function performPatientUpdate(name, age, gender, date, weight, height) {
      const updateBtn = document.getElementById('update-patient-btn');
      const originalContent = updateBtn.innerHTML;

      updateBtn.innerHTML = '<div class="loading"></div> Menyimpan...';
      updateBtn.disabled = true;

      const updatedData = {
        name: name,
        age: parseInt(age),
        gender: gender,
        weight: weight,
        height: height,
        registrationDate: date,
        lastUpdated: new Date().toISOString()
      };

      // Update patient registration
      database.ref(`patient_registrations/${editingPatientKey}`).update(updatedData).then(() => {
        console.log('✅ Patient registration updated');

        // If name changed, update all rehabilitation records
        if (name !== originalPatientName) {
          updatePatientNameInRehabRecords(originalPatientName, name);
        }

        // Reset form and show success
        cancelEditPatient();
        alert(`✅ Data pasien "${name}" berhasil diperbarui!`);

        // Reload patient list
        loadExistingPatients();

      }).catch(error => {
        console.error("Error updating patient:", error);
        alert("❌ Gagal memperbarui data pasien. Silakan coba lagi.");

        updateBtn.innerHTML = originalContent;
        updateBtn.disabled = false;
      });
    }

    function updatePatientNameInRehabRecords(oldName, newName) {
      // Update all rehabilitation records with the new name
      database.ref('rehabilitation').orderByChild('name').equalTo(oldName).once('value', snapshot => {
        if (snapshot.exists()) {
          const updates = {};
          snapshot.forEach(child => {
            updates[`rehabilitation/${child.key}/name`] = newName;
          });

          database.ref().update(updates).then(() => {
            console.log(`✅ Updated ${snapshot.numChildren()} rehabilitation records for patient name change`);
          }).catch(error => {
            console.error("Error updating rehabilitation records:", error);
          });
        }
      });
    }

    function validatePatientData(name, age, date) {
      const today = new Date().toISOString().split('T')[0];
      if (!name || name.length < 2) {
        return { valid: false, message: 'Nama pasien tidak valid.' };
      }
      if (isNaN(age) || parseInt(age) <= 0 || parseInt(age) > 120) {
        return { valid: false, message: 'Usia pasien tidak valid. Masukkan usia antara 1-120 tahun.' };
      }
      if (!date || date > today) {
        return { valid: false, message: 'Tanggal pendaftaran tidak valid atau lebih dari hari ini.' };
      }
      return { valid: true, message: 'Validasi berhasil.' };
    }

    function registerNewPatient() {
      const name = document.getElementById('new-patient-name').value.trim();
      const age = document.getElementById('new-patient-age').value;
      const gender = document.getElementById('new-patient-gender').value;
      const date = document.getElementById('new-patient-date').value;
      const weight = document.getElementById('new-patient-weight').value;
      const height = document.getElementById('new-patient-height').value;

      if (!name || !age || !gender || !date) {
        alert("⚠️ Lengkapi semua data pasien!");
        return;
      }

      const validation = validatePatientData(name, age, date);
      if (!validation.valid) {
        alert("⚠️ " + validation.message);
        return;
      }

      const registerBtn = document.getElementById('register-btn');
      const originalContent = registerBtn.innerHTML;
      registerBtn.innerHTML = '<div class="loading"></div> Menyimpan...';
      registerBtn.disabled = true;

      const newPatientRegistration = {
        name: name,
        age: parseInt(age),
        gender: gender,
        weight: weight ? parseFloat(weight) : null,
        height: height ? parseInt(height) : null,
        registrationDate: date,
        patientId: `${name.replace(/\s+/g, '_')}_${Date.now()}`,
        createdAt: new Date().toISOString(),
        isRegistration: true
      };

      const saveTimeout = setTimeout(() => {
        registerBtn.innerHTML = originalContent;
        registerBtn.disabled = false;
        alert("❌ Koneksi lambat. Periksa koneksi internet Anda.");
      }, 15000);

      database.ref('patient_registrations').push(newPatientRegistration).then(() => {
        clearTimeout(saveTimeout);

        clearNewPatientForm();
        cancelNewPatient();

        registerBtn.innerHTML = originalContent;
        registerBtn.disabled = false;

        alert(`✅ Pasien ${name} berhasil didaftarkan!\n\n📝 Untuk memulai sesi rehabilitasi:\n1. Pilih "Daftar Pasien"\n2. Klik nama pasien "${name}"\n3. Sesi pertama akan dimulai`);

      }).catch(error => {
        clearTimeout(saveTimeout);
        console.error("Error saving patient registration:", error);

        registerBtn.innerHTML = originalContent;
        registerBtn.disabled = false;

        alert("❌ Gagal mendaftarkan pasien. Silakan coba lagi.");
      });
    }

    let allPatients = [];   // Simpan semua pasien di sini
    let currentPage = 1;    // Halaman aktif
    const patientsPerPage = 5; // Maksimal 5 per halaman

    function renderPatients() {
      const container = document.getElementById('patient-cards-container');
      container.innerHTML = '';

      if (allPatients.length === 0) {
        container.innerHTML = '<div class="text-center py-8 text-slate-400">Belum ada pasien terdaftar</div>';
        return;
      }

      // Hitung index pasien yang tampil
      const startIndex = (currentPage - 1) * patientsPerPage;
      const endIndex = startIndex + patientsPerPage;
      const patientsToShow = allPatients.slice(startIndex, endIndex);

      patientsToShow.forEach(patient => {
        const patientCard = document.createElement('div');
        patientCard.className = 'patient-card';
        patientCard.innerHTML = `
      <div class="flex justify-between items-center">
        <div>
          <h4 class="font-bold text-lg text-blue-300"><i class="fas fa-user mr-2"></i>${patient.name}</h4>
          <p class="text-slate-400 mt-1"><i class="fas fa-birthday-cake mr-2"></i>Usia: ${patient.age} tahun</p>
          <p class="text-slate-400"><i class="fas fa-venus-mars mr-2"></i>Jenis Kelamin: ${patient.gender || 'Tidak Diketahui'}</p>
          <p class="text-slate-400"><i class="fas fa-calendar mr-2"></i>Terdaftar: ${new Date(patient.registrationDate).toLocaleDateString('id-ID')}</p>
          <p class="text-green-400 font-semibold mt-2">
            <i class="fas fa-list-ol mr-2"></i>Sesi selesai: ${patient.completedSessions}
            <span class="ml-3"><i class="fas fa-arrow-right mr-2"></i>Sesi selanjutnya: ${patient.nextSession}</span>
          </p>
        </div>
        <div class="flex flex-col items-center gap-2">
          <button onclick="selectExistingPatientViewOnly('${patient.name}', ${patient.age})" class="btn-info">
            <i class="fas fa-eye"></i> Lihat
          </button>
          <button onclick="editPatient('${patient.firebaseKey}', '${patient.name.replace(/'/g, "\\'")}', ${patient.age}, '${patient.gender}')" class="btn-warning">
            <i class="fas fa-edit"></i> Edit
          </button>
          <button onclick="deletePatient('${patient.firebaseKey}', '${patient.name.replace(/'/g, "\\'")}')"
              class="btn-danger" style="padding: 6px 12px; font-size: 12px;">
        <i class="fas fa-trash"></i> Hapus
      </button>
          <div class="text-2xl text-blue-400">
            <i class="fas fa-chevron-right"></i>
          </div>
        </div>
      </div>
    `;

        patientCard.addEventListener('click', (e) => {
          if (!e.target.closest('button')) {
            selectExistingPatientForSession(patient);
          }
        });

        container.appendChild(patientCard);
      });

      renderPagination();
    }
    function deletePatient(firebaseKey, name) {
      if (!confirm(`⚠️ Hapus pasien "${name}"?\nSemua data rehabilitasi terkait juga akan dihapus.\nTindakan ini tidak dapat dibatalkan!`)) {
        return;
      }

      // Hapus data registrasi pasien
      database.ref(`patient_registrations/${firebaseKey}`).remove()
        .then(() => {
          // Hapus semua data rehabilitasi terkait
          return database.ref('rehabilitation').orderByChild('name').equalTo(name).once('value');
        })
        .then((snapshot) => {
          const updates = {};
          snapshot.forEach(child => {
            updates[`rehabilitation/${child.key}`] = null;
          });
          return database.ref().update(updates);
        })
        .then(() => {
          alert(`✅ Pasien "${name}" dan semua datanya berhasil dihapus.`);
          loadExistingPatients(); // Refresh daftar
        })
        .catch((error) => {
          console.error("Gagal menghapus pasien:", error);
          alert("❌ Gagal menghapus pasien. Coba lagi.");
        });
    }
    function renderPagination() {
      const paginationContainer = document.getElementById('pagination-container') || document.createElement('div');
      paginationContainer.id = 'pagination-container';
      paginationContainer.className = 'flex justify-center mt-4 space-x-2';

      const totalPages = Math.ceil(allPatients.length / patientsPerPage);
      paginationContainer.innerHTML = '';

      // Tombol Previous
      const prevBtn = document.createElement('button');
      prevBtn.className = 'btn-secondary';
      prevBtn.innerHTML = '&laquo; Prev';
      prevBtn.disabled = currentPage === 1;
      prevBtn.onclick = () => {
        if (currentPage > 1) {
          currentPage--;
          renderPatients();
        }
      };
      paginationContainer.appendChild(prevBtn);

      // Tombol Halaman
      for (let i = 1; i <= totalPages; i++) {
        const pageBtn = document.createElement('button');
        pageBtn.className =
          `px-3 py-1 rounded-lg text-sm font-medium transition ` +
          (i === currentPage
            ? 'bg-blue-500 text-white'
            : 'bg-gray-200 text-gray-700 hover:bg-gray-300');
        pageBtn.textContent = i;
        pageBtn.onclick = () => {
          currentPage = i;
          renderPatients();
        };
        paginationContainer.appendChild(pageBtn);
      }


      // Tombol Next
      const nextBtn = document.createElement('button');
      nextBtn.className = 'btn-secondary';
      nextBtn.innerHTML = 'Next &raquo;';
      nextBtn.disabled = currentPage === totalPages;
      nextBtn.onclick = () => {
        if (currentPage < totalPages) {
          currentPage++;
          renderPatients();
        }
      };
      paginationContainer.appendChild(nextBtn);

      // Tambah ke bawah container pasien
      const container = document.getElementById('patient-cards-container');
      container.appendChild(paginationContainer);
    }

    function loadExistingPatients() {
      const container = document.getElementById('patient-cards-container');
      container.innerHTML = '<div class="text-center py-4 text-slate-400">🔄 Memuat data pasien...</div>';

      database.ref('patient_registrations').once('value', snapshot => {
        const patientMap = new Map();

        if (!snapshot.exists()) {
          container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fas fa-user-slash text-4xl mb-4"></i><br>Belum ada pasien terdaftar</div>';
          return;
        }

        snapshot.forEach(child => {
          const data = child.val();
          const key = data.name;

          if (!patientMap.has(key)) {
            patientMap.set(key, {
              ...data,
              firebaseKey: child.key
            });
          }
        });

        const patientPromises = Array.from(patientMap.values()).map(patient => {
          return new Promise((resolve) => {
            database.ref('rehabilitation').orderByChild('name').equalTo(patient.name).once('value', rehabSnapshot => {
              const sessionCount = rehabSnapshot.numChildren();
              const nextSession = sessionCount + 1;

              resolve({
                ...patient,
                completedSessions: sessionCount,
                nextSession: nextSession
              });
            });
          });
        });

        Promise.all(patientPromises).then(patientsWithSessions => {
          allPatients = patientsWithSessions; // simpan semua pasien
          currentPage = 1; // reset ke halaman 1
          renderPatients();
        });
      }).catch(error => {
        console.error("Error loading patients:", error);
        container.innerHTML = '<div class="text-center py-8 text-red-400">❌ Gagal memuat data pasien. <button onclick="loadExistingPatients()" class="btn-info ml-2">Coba Lagi</button></div>';
      });
    }


    function selectExistingPatientViewOnly(name, age) {
      selectedPatient = {
        name: name,
        age: age,
        date: new Date().toISOString().split('T')[0],
        rehabSession: null,
        patientId: `${name.replace(/\s+/g, '_')}_view`,
        isViewOnly: true
      };

      loadPatientMVCCalibration(name);

      isViewOnlyMode = true;
      updatePatientInfoBar();
      updateViewOnlyMode();
      cancelExistingPatient();

      alert(`👁️ Menampilkan data untuk pasien ${name} (mode lihat saja)`);

      document.querySelectorAll('.sidebar-item').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.sidebar-item')[1].classList.add('active');
      showTab('realtime-monitor');
    }

    function viewDataOnly() {
      if (!selectedPatient) return;

      isViewOnlyMode = true;
      updateViewOnlyMode();
      alert(`👁️ Beralih ke mode lihat data untuk pasien ${selectedPatient.name}`);
    }

    function startNewSession() {
      if (!selectedPatient || !isViewOnlyMode) return;

      const name = selectedPatient.name;
      const today = new Date().toISOString().split('T')[0];

      // Gunakan jumlah sesi yang ada sebagai basis (lebih tahan terhadap data rehabSession yang korup)
      database.ref('rehabilitation').orderByChild('name').equalTo(name).once('value').then(snap => {
        const count = snap && snap.exists() ? snap.numChildren() : 0;
        const nextSession = count + 1;
        const newPatientSession = {
          name: selectedPatient.name,
          age: selectedPatient.age,
          date: today,
          rehabSession: nextSession,
          patientId: `${selectedPatient.name.replace(/\s+/g, '_')}_${Date.now()}`,
          createdAt: new Date().toISOString()
        };
        return database.ref('patients').push(newPatientSession).then(() => {
          selectedPatient = newPatientSession;
          isViewOnlyMode = false;
          updatePatientInfoBar();
          updateViewOnlyMode();
          initializeFirebaseRealtimeListener();
          alert(`✅ Sesi baru (${nextSession}) dimulai untuk pasien ${selectedPatient.name}!`);
        });
      }).catch(error => {
        console.error("Error starting new session:", error);
        alert("❌ Gagal memulai sesi baru. Silakan coba lagi.");
      });
    }

    function updateViewOnlyMode() {
      const sessionControlPanel = document.getElementById('session-control-panel');
      const viewOnlyNotice = document.getElementById('view-only-notice');

      if (isViewOnlyMode) {
        sessionControlPanel.style.display = 'none';
        viewOnlyNotice.style.display = 'block';
      } else {
        sessionControlPanel.style.display = 'block';
        viewOnlyNotice.style.display = 'none';
      }
    }

    function selectExistingPatientForSession(patient) {
      try {
        Promise.all([
          database.ref('rehabilitation').orderByChild('name').equalTo(patient.name).once('value'),
          database.ref('patients').orderByChild('name').equalTo(patient.name).once('value')
        ]).then(([rehabSnap, patientsSnap]) => {
          let maxSession = 0;
          let sessionData = [];

          // Ambil data dari rehabilitation
          if (rehabSnap.exists()) {
            rehabSnap.forEach(child => {
              const val = child.val();
              const s = Number(val.rehabSession) || 0;
              if (s > maxSession) maxSession = s;

              sessionData.push(val);
            });
          }

          // Ambil data dari patients
          if (patientsSnap.exists()) {
            patientsSnap.forEach(child => {
              const val = child.val();
              const s = Number(val.rehabSession) || 0;
              if (s > maxSession) maxSession = s;

              sessionData.push(val);
            });
          }

          const nextSession = maxSession + 1;
          const todayString = new Date().toISOString().split('T')[0];

          // Set selectedPatient global
          selectedPatient = {
            name: patient.name,
            age: patient.age,
            weight: patient.weight,
            height: patient.height,
            date: todayString,
            rehabSession: maxSession, // pakai sesi terakhir, bukan increment
            patientId: patient.patientId || `${patient.name.replace(/\s+/g, '_')}_${Date.now()}`,
            createdAt: new Date().toISOString()
          };

          // 🔑 Set currentSessionData global biar export bisa jalan
          currentSessionData = sessionData;
          console.log("✅ Data sesi terisi:", currentSessionData);

          isViewOnlyMode = false;
          updatePatientInfoBar();

          // Tutup daftar & tampilkan realtime
          cancelExistingPatient();
          document.getElementById("no-patient-warning-realtime").style.display = "none";
          document.getElementById("realtime-content").style.display = "block";

          showTab('realtime-monitor');

          // Muat kalibrasi MVC
          loadPatientMVCCalibration(patient.name).then(() => {
            initializeChartsWithCurrentTime();
          });
        }).catch(error => {
          console.error('Error determining next session:', error);

          // Minimal set agar UI tetap jalan tanpa warning
          selectedPatient = {
            name: patient.name,
            age: patient.age,
            date: new Date().toISOString().split('T')[0],
            rehabSession: Number(patient.rehabSession) || 0,
            patientId: patient.patientId || `${patient.name.replace(/\s+/g, '_')}_${Date.now()}`
          };

          currentSessionData = []; // fallback kosong
          isViewOnlyMode = false;
          updatePatientInfoBar();
          cancelExistingPatient();

          document.querySelectorAll('.sidebar-item').forEach(item => item.classList.remove('active'));
          document.querySelectorAll('.sidebar-item')[1].classList.add('active');

          showTab('realtime-monitor');
          initializeChartsWithCurrentTime();
        });
      } catch (error) {
        console.error('Unexpected error:', error);
      }
    }
    function initializeChartsWithCurrentTime() {
      console.log('[Charts] Initializing charts with current time...');

      const now = new Date();
      const currentTime = now.toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      // Check if charts exist before initializing
      if (!angleChart || !emgChart) {
        console.log('[Charts] Creating new chart instances...');
        createChartInstances();
      }

      // Initialize with default data
      if (angleChart) {
        angleChart.data.labels = [currentTime];
        angleChart.data.datasets[0].data = [0];
        angleChart.update();
        console.log('[Charts] Angle chart initialized');
      }

      if (emgChart) {
        emgChart.data.labels = [currentTime];
        emgChart.data.datasets[0].data = [0];
        emgChart.options.scales.y.title.text = 'RMS EMG (mV)';

        emgChart.update();
        console.log('[Charts] EMG chart initialized');
      }

      // Reset display values
      document.getElementById('average-angle').textContent = '0°';
      document.getElementById('average-rms-emg').textContent = '0mV';

      currentRMSValues = [];
      avgRMSEMG = 0;

      updateConnectionStatus(false);
      console.log('[Charts] Chart initialization complete');
    }

    // Separate function to create chart instances
    function createChartInstances() {
      console.log('[Charts] Creating chart instances...');

      // Create angle chart
      const angleCanvas = document.getElementById('angle-chart');
      if (angleCanvas && !angleChart) {
        angleChart = new Chart(angleCanvas, {
          type: 'line',
          data: {
            labels: [],
            datasets: [{
              label: 'Sudut (°)',
              data: [],
              borderColor: '#3b82f6',
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              fill: true,
              tension: 0.4,
              pointRadius: 4,
              pointHoverRadius: 6
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                display: true,
                labels: {
                  color: '#e2e8f0'
                }
              }
            },
            scales: {
              x: {
                ticks: { color: '#94a3b8' },
                grid: { color: 'rgba(148, 163, 184, 0.1)' }
              },
              y: {
                beginAtZero: true,
                max: 180,
                ticks: { color: '#94a3b8' },
                grid: { color: 'rgba(148, 163, 184, 0.1)' },
                title: {
                  display: true,
                  text: 'Sudut (°)',
                  color: '#e2e8f0'
                }
              }
            }
          }
        });
        console.log('[Charts] Angle chart created');
      }

      // Create EMG chart
      const emgCanvas = document.getElementById('emg-chart');
      if (emgCanvas && !emgChart) {
        emgChart = new Chart(emgCanvas, {
          type: 'line',
          data: {
            labels: [],
            datasets: [
              {
                label: 'RMS EMG (mV)',
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.1)',
                data: [],
                tension: 0.4,
                yAxisID: 'y1'
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
              mode: 'index',
              intersect: false,
            },
            plugins: {
              legend: {
                display: true,
                labels: {
                  color: '#e2e8f0',
                  font: {
                    size: 12
                  }
                }
              },
              title: {
                display: true,
                text: 'Real-time EMG Signal Analysis',
                color: '#e2e8f0'
              }
            },
            scales: {
              x: {
                ticks: { color: '#94a3b8' },
                grid: { color: 'rgba(148, 163, 184, 0.1)' }
              },
              y: {
                type: 'linear',
                display: true,
                position: 'left',
                beginAtZero: true,
                max: EMG_CONSTANTS.MAX_EMG_PERCENTAGE,
                ticks: { color: '#94a3b8' },
                grid: { color: 'rgba(148, 163, 184, 0.1)' },
                title: {
                  display: true,
                  text: 'RMS EMG (mV)',
                  color: '#10b981'
                }
              }
            }
          }
        });
        console.log('[Charts] EMG chart created');
      }
    }

    function updatePatientInfoBar() {
      if (selectedPatient) {
        document.getElementById('patient-info-bar').classList.add('active');
        document.getElementById('active-patient-name').textContent = selectedPatient.name;
        document.getElementById('active-patient-age').textContent = selectedPatient.age + ' tahun';
        // Tampilkan nomor sesi hanya saat sesi benar-benar aktif; jika belum, tampilkan '-'
        const sessionText = (isSessionActive && selectedPatient.rehabSession && Number(selectedPatient.rehabSession) > 0)
          ? selectedPatient.rehabSession
          : '-';
        document.getElementById('active-patient-session').textContent = sessionText;
        updateMVCDisplay(currentMVCReference, null);
      } else {
        document.getElementById('patient-info-bar').classList.remove('active');
        updateMVCDisplay(null, null);
      }
    }

    function resetPatientSelection() {
      selectedPatient = null;
      isViewOnlyMode = false;
      updatePatientInfoBar();

      if (isSessionActive) {
        endSession();
      }

      clearSessionData();

      document.querySelectorAll('.sidebar-item').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.sidebar-item')[0].classList.add('active');
      showTab('patient-selection');

      cancelNewPatient();
      cancelExistingPatient();

      updateTabsForNoPatient();
    }
    function getGradeFromPoints(points) {
      if (points >= 1.5) return { grade: "A", icon: "🏆" };
      if (points >= 1.0) return { grade: "B", icon: "🥈" };
      if (points >= 0.5) return { grade: "C", icon: "🥉" };
      if (points > 0) return { grade: "D", icon: "⚠️" };
      return { grade: "E", icon: "❌" };
    }

    function exportToPDF(type = 'data') {
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF('landscape', 'mm', 'a4');

      const dataPromise = selectedPatient ?
        refreshDataForSelectedPatient(selectedPatient.name) :
        refreshAllData();

      dataPromise.then(freshData => {
        let dataToExport = [];
        let titlePrefix = (type === 'log') ? 'Log Aktivitas' : 'Data Rehabilitasi';
        dataToExport = freshData;

        if (dataToExport.length === 0) {
          alert("⚠️ Tidak ada data untuk diekspor");
          return;
        }

        // Urutkan berdasarkan nama & sesi
        dataToExport.sort((a, b) => {
          if (a.name === b.name) return a.rehabSession - b.rehabSession;
          return a.name.localeCompare(b.name);
        });

        // Ambil gender dari database
        database.ref('patient_registrations').once('value', regSnapshot => {
          const patientGenderMap = new Map();
          if (regSnapshot.exists()) {
            regSnapshot.forEach(child => {
              const regData = child.val();
              patientGenderMap.set(regData.name, regData.gender || 'Tidak Diketahui');
            });
          }

          dataToExport = dataToExport.map(data => {
            const mvcReference = getSafeMVCReference(data.mvcReference || currentMVCReference);
            const percentMVC = convertEMGToPercentage(data.avgRMSEMG || 0, mvcReference);

            const romValue = data.totalROM || data.avgAngle || 0;
            const romPoints = romValue >= 120 ? 1.5 : (romValue >= 90 ? 1.0 : (romValue >= 60 ? 0.5 : 0));
            const emgPoints = percentMVC >= 60 ? 1.5 : (percentMVC >= 40 ? 1.0 : (percentMVC >= 20 ? 0.5 : 0));

            const romGrade = getGradeFromPoints(romPoints);
            const rmsGrade = getGradeFromPoints(emgPoints);

            return {
              ...data,
              gender: patientGenderMap.get(data.name) || 'Tidak Diketahui',
              romGrade: romGrade.grade,  // ✅ Hanya huruf
              rmsGrade: rmsGrade.grade   // ✅ Hanya huruf
            };
          });


          // Kirim ke generatePDFWithMVCData
          generatePDFWithMVCData(pdf, dataToExport, titlePrefix, type);
        }).catch(error => {
          console.error("Error ambil data pasien:", error);
          dataToExport = dataToExport.map(data => ({
            ...data,
            gender: 'Tidak Diketahui',
            romGrade: 'D ⚠️',
            rmsGrade: 'D ⚠️'
          }));
          generatePDFWithMVCData(pdf, dataToExport, titlePrefix, type);
        });
      });
    }


    function generatePDFWithMVCData(pdf, dataToExport, titlePrefix, type) {
      const pageWidth = pdf.internal.pageSize.width;
      const pageHeight = pdf.internal.pageSize.height;

      try {
        // Header profesional
        pdf.setFillColor(30, 58, 138);
        pdf.rect(0, 0, pageWidth, 60, 'F');

        pdf.setFillColor(255, 255, 255);
        pdf.rect(20, 15, 20, 4, 'F');
        pdf.rect(28, 10, 4, 14, 'F');

        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(24);
        pdf.setFont(undefined, 'bold');
        pdf.text('KNEE ASSISTIVE DEVICE', 50, 28);

        pdf.setFontSize(14);
        pdf.setFont(undefined, 'normal');
        pdf.text('Laporan Rehabilitasi', 50, 38);

        pdf.setFontSize(11);
        const reportScope = selectedPatient ?
          `Pasien: ${selectedPatient.name}` :
          'Laporan Komprehensif - Semua Pasien';
        pdf.text(reportScope, 50, 48);

        let currentY = 75;

        // Info dokumen
        pdf.setFillColor(59, 130, 246);
        pdf.rect(15, currentY - 5, pageWidth - 30, 12, 'F');
        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(12);
        pdf.setFont(undefined, 'bold');
        pdf.text('INFORMASI DOKUMEN & KALIBRASI', 20, currentY + 3);

        pdf.setFillColor(248, 250, 252);
        pdf.rect(15, currentY + 7, pageWidth - 30, 35, 'F');
        pdf.setDrawColor(200, 200, 200);
        pdf.setLineWidth(0.5);
        pdf.rect(15, currentY - 5, pageWidth - 30, 47);

        currentY += 17;
        pdf.setTextColor(51, 65, 85);
        pdf.setFont(undefined, 'normal');
        pdf.setFontSize(10);

        const now = new Date();
        const patientGender = selectedPatient ?
          (dataToExport.find(d => d.name === selectedPatient.name)?.gender || 'Tidak Diketahui') :
          'Tidak Diketahui';

        const dates = dataToExport.map(d => new Date(d.date)).sort((a, b) => a - b);
        const startDate = dates.length > 0 ? dates[0].toLocaleDateString('id-ID') : '-';
        const endDate = dates.length > 0 ? dates[dates.length - 1].toLocaleDateString('id-ID') : '-';

        const infoLeft = [
          ['Nama:', selectedPatient ? selectedPatient.name : 'Semua Pasien'],
          ['Usia:', selectedPatient ? `${selectedPatient.age} tahun` : '-'],
          ['Jenis Kelamin:', patientGender]
        ];

        const infoRight = [
          ['Tanggal Cetak:', now.toLocaleDateString('id-ID')],
          ['Waktu Pembuatan:', now.toLocaleTimeString('id-ID')],
          ['Total Data:', `${dataToExport.length} sesi`],
          ['Periode Data:', `${startDate} - ${endDate}`]
        ];

        // Print kolom kiri dan kanan
        infoLeft.forEach((item, index) => {
          const yPos = currentY + (index * 5);
          pdf.setFont(undefined, 'normal');
          pdf.setTextColor(51, 65, 85);
          pdf.text(item[0], 20, yPos);
          pdf.setFont(undefined, 'bold');
          pdf.setTextColor(59, 130, 246);
          pdf.text(item[1], 70, yPos);
        });

        infoRight.forEach((item, index) => {
          const yPos = currentY + (index * 5);
          pdf.setFont(undefined, 'normal');
          pdf.setTextColor(51, 65, 85);
          pdf.text(item[0], 110, yPos);
          pdf.setFont(undefined, 'bold');
          pdf.setTextColor(59, 130, 246);
          pdf.text(item[1], 150, yPos);
        });

        currentY += 30;

        // Header tabel di tengah
        pdf.setFillColor(30, 58, 138);
        pdf.rect(15, currentY, pageWidth - 30, 15, 'F');
        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(14);
        pdf.setFont(undefined, 'bold');
        pdf.text('DATA REHABILITASI PASIEN', pageWidth / 2, currentY + 10, { align: 'center' });

        currentY += 20;

        // Header tabel sesuai UI dengan 2 Grade
        const headers = [[
          'No', 'Nama', 'Usia', 'Jenis Kelamin', 'Tanggal', 'Sesi', 'Durasi',
          'ROM Total (°)', 'Fleksi Max (°)', 'Ekstensi Max (°)',
          'RMS EMG (mV)', '%MVC', 'Grade ROM', 'Grade RMS'
        ]];

        // Data tabel
        const tableData = dataToExport.map((d, index) => {
          const duration = d.sessionDuration
            ? new Date(d.sessionDuration * 1000).toISOString().substr(11, 8)
            : '-';

          let genderShort = 'N/A';
          if (d.gender) {
            if (d.gender.toLowerCase().includes('laki')) genderShort = 'L';
            else if (d.gender.toLowerCase().includes('perempuan')) genderShort = 'P';
          }

          // Hitung %MVC
          const mvcReference = getSafeMVCReference(d.mvcReference || currentMVCReference);
          const percentMVC = convertEMGToPercentage(d.avgRMSEMG || 0, mvcReference);
          const percentMVCDisplay = formatEMGDisplay(percentMVC, "percentage");
          const rmsDisplay = formatEMGDisplay(d.avgRMSEMG || 0, "raw");

          return [
            (index + 1).toString(), // No
            d.name || "N/A",        // Nama
            d.age || "-",           // Usia
            genderShort,            // Jenis Kelamin
            new Date(d.date).toLocaleDateString("id-ID"), // Tanggal
            d.rehabSession || "-",  // Sesi
            duration,               // Durasi
            `0.0° - ${(d.maxFlexion || d.totalROM || d.avgAngle || 0).toFixed(1)}°`, // ROM Total
            d.maxFlexion ? d.maxFlexion.toFixed(1) + "°" : "0.0", // Fleksi Max
            d.maxExtension ? Math.abs(d.maxExtension).toFixed(1) + "°" : "0.0", // Ekstensi Max
            rmsDisplay,             // RMS EMG
            percentMVCDisplay,      // %MVC
            d.romGrade || "-",       // ✅ Grade ROM
            d.rmsGrade || "-"        // ✅ Grade RMS
          ];

        });

        pdf.autoTable({
          head: headers,
          body: tableData,
          startY: currentY,
          theme: 'grid',
          tableWidth: 'wrap',
          styles: {
            fontSize: 9,
            cellPadding: { top: 3, right: 2, bottom: 3, left: 2 },
            textColor: [51, 65, 85],
            lineColor: [200, 200, 200],
            lineWidth: 0.3,
            overflow: 'linebreak',
            cellWidth: 'wrap',
            halign: 'center',
            valign: 'middle'
          },
          headStyles: {
            fillColor: [30, 58, 138],
            textColor: [255, 255, 255],
            fontStyle: 'bold',
            fontSize: 10,
            halign: 'center',
            valign: 'middle',
            cellPadding: { top: 4, right: 2, bottom: 4, left: 2 }
          },
          columnStyles: {
            0: { halign: "center", fontStyle: "bold", cellWidth: 10 },
            1: { halign: "left", fontStyle: "bold", cellWidth: 23 },
            2: { halign: "center", cellWidth: 12 },
            3: { halign: "center", cellWidth: 20 },
            4: { halign: "center", cellWidth: 22 },
            5: { halign: "center", textColor: [59, 130, 246], cellWidth: 15 },
            6: { halign: "center", textColor: [139, 92, 246], cellWidth: 23 },
            7: { halign: "center", textColor: [16, 185, 129], cellWidth: 20 },
            8: { halign: "center", textColor: [34, 197, 94], cellWidth: 20 },
            9: { halign: "center", textColor: [59, 130, 246], cellWidth: 20 },
            10: { halign: "center", textColor: [16, 185, 129], cellWidth: 25 },
            11: { halign: "center", textColor: [239, 68, 68], cellWidth: 20 },
            12: { halign: "center", fontStyle: "bold", cellWidth: 20 }, // Grade ROM
            13: { halign: "center", fontStyle: "bold", cellWidth: 20 }  // Grade RMS
          },

          // ✅ Diletakkan di sini, di dalam konfigurasi
          alternateRowStyles: { fillColor: [248, 250, 252] },
          didParseCell: function (data) {
            if ((data.column.index === 12 || data.column.index === 13) && data.section === 'body') {
              const grade = data.cell.raw;
              switch (grade) {
                case 'A': data.cell.styles.fillColor = [34, 197, 94]; break;
                case 'B': data.cell.styles.fillColor = [59, 130, 246]; break;
                case 'C': data.cell.styles.fillColor = [245, 158, 11]; break;
                case 'D': data.cell.styles.fillColor = [239, 68, 68]; break;
                case 'E': data.cell.styles.fillColor = [107, 114, 128]; break;
              }
              data.cell.styles.textColor = [255, 255, 255];
              data.cell.styles.fontStyle = 'bold';
            }
          },
          table: { halign: 'center' }
        });

        // Statistik - halaman baru jika perlu
        if (pdf.lastAutoTable.finalY > pageHeight - 120) {
          pdf.addPage();
          currentY = 30;
        } else {
          currentY = pdf.lastAutoTable.finalY + 20;
        }

        // Header statistik di tengah
        pdf.setFillColor(34, 197, 94);
        pdf.rect(15, currentY - 5, pageWidth - 30, 15, 'F');
        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(14);
        pdf.setFont(undefined, 'bold');
        pdf.text('RINGKASAN STATISTIK & ANALISIS', pageWidth / 2, currentY + 5, { align: 'center' });

        currentY += 20;

        // Hitung statistik
        const romValues = dataToExport.map(d => d.avgAngle || 0);
        const rmsValues = dataToExport.map(d => d.avgRMSEMG || 0);
        const mavValues = dataToExport.map(d => d.avgMAVEMG || 0);
        const durations = dataToExport.map(d => d.sessionDuration || 0);

        const stats = {
          totalSessions: dataToExport.length,
          avgROM: romValues.length > 0 ? romValues.reduce((a, b) => a + b, 0) / romValues.length : 0,
          maxROM: romValues.length > 0 ? Math.max(...romValues) : 0,
          minROM: romValues.length > 0 ? Math.min(...romValues) : 0,
          avgRMS: rmsValues.length > 0 ? rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length : 0,
          avgMAV: mavValues.length > 0 ? mavValues.reduce((a, b) => a + b, 0) / mavValues.length : 0,
          totalDuration: durations.reduce((a, b) => a + b, 0),
          avgDuration: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0
        };

        const statsData = [
          ['Parameter', 'Nilai'],
          ['Total Sesi Rehabilitasi', `${stats.totalSessions} sesi`],
          ['ROM - Rata-rata', `${stats.avgROM.toFixed(1)}°`],
          ['ROM - Tertinggi', `${stats.maxROM.toFixed(1)}°`],
          ['ROM - Terendah', `${stats.minROM.toFixed(1)}°`],
          ['RMS EMG - Rata-rata', `${stats.avgRMS.toFixed(1)} mV`],
          ['Total Durasi Semua Sesi', formatDurationForPDF(stats.totalDuration)],
          ['Rata-rata Durasi per Sesi', formatDurationForPDF(Math.floor(stats.avgDuration))]
        ];

        pdf.autoTable({
          head: [statsData[0]],
          body: statsData.slice(1),
          startY: currentY,
          margin: { left: 15, right: 15 },
          theme: 'grid',
          styles: {
            fontSize: 11,
            cellPadding: 6,
            textColor: [51, 65, 85],
            lineColor: [200, 200, 200],
            lineWidth: 0.5
          },
          headStyles: {
            fillColor: [34, 197, 94],
            textColor: [255, 255, 255],
            fontStyle: 'bold',
            fontSize: 12,
            halign: 'center',
            valign: 'middle'
          },
          columnStyles: {
            0: { fontStyle: 'normal', cellWidth: 134, fillColor: [248, 250, 252], halign: 'center' },
            1: { fontStyle: 'bold', cellWidth: 134, textColor: [34, 197, 94], halign: 'center' }
          }
        });

        // Distribusi Grade
        let gradeY;
        if (pdf.lastAutoTable.finalY > pageHeight - 60) {
          pdf.addPage();
          gradeY = 30;
        } else {
          gradeY = pdf.lastAutoTable.finalY + 15;
        }

        // Header Section
        pdf.setFillColor(147, 51, 234);
        pdf.rect(15, gradeY - 5, pageWidth - 30, 15, 'F');
        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(14);
        pdf.setFont(undefined, 'bold');
        pdf.text(' DISTRIBUSI GRADE', 20, gradeY + 5);

        gradeY += 20;

        // Hitung Grade ROM dan EMG Terpisah
        const gradeCountROM = { A: 0, B: 0, C: 0, D: 0 };
        const gradeCountEMG = { A: 0, B: 0, C: 0, D: 0 };

        dataToExport.forEach(d => {
          const mvcReference = getSafeMVCReference(d.mvcReference || currentMVCReference);
          const percentMVC = convertEMGToPercentage(d.avgRMSEMG || 0, mvcReference);
          let romValue = d.maxFlexion || d.totalROM || d.avgAngle || 0;

          // Klasifikasi ROM
          if (romValue >= 120) gradeCountROM.A++;
          else if (romValue >= 100) gradeCountROM.B++;
          else if (romValue >= 80) gradeCountROM.C++;
          else gradeCountROM.D++;

          // Klasifikasi EMG
          if (percentMVC >= 60) gradeCountEMG.A++;
          else if (percentMVC >= 45) gradeCountEMG.B++;
          else if (percentMVC >= 30) gradeCountEMG.C++;
          else gradeCountEMG.D++;
        });

        // Tabel Format Web (3 Kolom: Grade | ROM | EMG)
        const gradeData = [
          ['Grade', ' ROM', ' EMG'],
          [' Grade A', `${gradeCountROM.A}`, `${gradeCountEMG.A}`],
          [' Grade B', `${gradeCountROM.B}`, `${gradeCountEMG.B}`],
          [' Grade C', `${gradeCountROM.C}`, `${gradeCountEMG.C}`],
          [' Grade D', `${gradeCountROM.D}`, `${gradeCountEMG.D}`]
        ];

        pdf.autoTable({
          head: [gradeData[0]],
          body: gradeData.slice(1),
          startY: gradeY,
          theme: 'grid',
          tableWidth: 'full',   // ⬅️ Membuat tabel memanjang kanan-kiri
          margin: { left: 15, right: 15 },

          styles: {
            fontSize: 11,
            cellPadding: 8,
            textColor: [51, 65, 85],
            lineColor: [200, 200, 200],
            lineWidth: 0.5,
            halign: 'center',
            valign: 'middle'
          },

          headStyles: {
            fillColor: [147, 51, 234],
            textColor: [255, 255, 255],
            fontStyle: 'bold',
            fontSize: 12,
            cellPadding: 10
          },

          columnStyles: {
            0: { cellWidth: 'auto', halign: 'left', fontStyle: 'bold', fontSize: 11 },
            1: { cellWidth: 'auto', fontStyle: 'bold', fontSize: 13, textColor: [147, 51, 234] },
            2: { cellWidth: 'auto', fontStyle: 'bold', fontSize: 13, textColor: [34, 197, 94] }
          },

          didParseCell: function (data) {
            if (data.column.index === 0 && data.section === 'body') {
              const colors = [
                [34, 197, 94],   // A
                [59, 130, 246],  // B
                [245, 158, 11],  // C
                [239, 68, 68]    // D
              ];
              if (data.row.index < colors.length) {
                data.cell.styles.fillColor = colors[data.row.index];
                data.cell.styles.textColor = [255, 255, 255];
              }
            }
          }
        });
        // Footer untuk semua halaman
        const totalPages = pdf.internal.getNumberOfPages();
        for (let i = 1; i <= totalPages; i++) {
          pdf.setPage(i);
          addProfessionalFooter(pdf, i, totalPages);
        }

      } catch (error) {
        console.error('Error generating PDF:', error);
        alert('❌ Terjadi kesalahan saat membuat PDF: ' + error.message);
        return;
      }

      const timestamp = new Date().toISOString().split('T')[0];
      const filename = selectedPatient ?
        `KneeAssistive_Professional_${selectedPatient.name.replace(/\s+/g, '_')}_${timestamp}.pdf` :
        `KneeAssistive_Professional_Report_${timestamp}.pdf`;

      pdf.save(filename);
      alert(`✅ Laporan profesional berhasil diekspor!\n\nFile: ${filename}\n\n📊 Konten laporan:\n• Header profesional dengan logo\n• Informasi dokumen lengkap\n• Tabel data dengan color coding\n• Statistik komprehensif\n• Distribusi grade dengan visual\n• Footer profesional`);
    }

    function updateTabsForSelectedPatient() {
      document.querySelector('#log-aktivitas .table').classList.add('hide-nama-tanggal');
      document.querySelector('#data .table').classList.add('hide-nama-tanggal');
      const warnings = ['no-patient-warning', 'no-patient-warning-realtime', 'no-patient-warning-analysis', 'log-no-patient', 'data-no-patient'];
      warnings.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });

      const content = ['realtime-content', 'analysis-classification-content'];
      content.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'block';
      });

      updateMVCDisplay(currentMVCReference, null);
      updateViewOnlyMode();
      loadFilteredData();
      updateComparisonChart();

      setTimeout(() => {
        const latestData = currentSessionData[currentSessionData.length - 1];
        if (latestData) {
          const romStats = {
            totalROM: romAnalysisData.totalROM,
            consistency: romAnalysisData.consistency
          };
          const emgFeaturesInMVC = {
            rms: latestData.rmsEMG,
            mav: latestData.mavEMG,
            variance: 0,
            waveformLength: 0,
            zeroCrossings: 0,
            slopeSignChanges: 0
          };
          const classification = classifyRehabilitationPerformanceMVC(emgFeaturesInMVC, romStats, currentMVCReference);
          updateClassificationDisplay(classification);
          updateRealtimeFeatureDisplayMVC(emgFeaturesInMVC, latestData);
          updateCombinedAnalysisChart();
          updateClassificationChart();
        } else {
          updateClassificationDisplay({ grade: 'N/A', status: 'Menunggu data...', description: 'Menunggu data ROM dan EMG untuk klasifikasi.' });
          updateRealtimeFeatureDisplayMVC({ rms: 0, mav: 0, variance: 0, waveformLength: 0, zeroCrossings: 0, slopeSignChanges: 0 }, { mvcReference: currentMVCReference });
        }
      }, 100);
    }

    function updateTabsForNoPatient() {
      document.querySelector('#log-aktivitas .table').classList.remove('hide-nama-tanggal');
      document.querySelector('#data .table').classList.remove('hide-nama-tanggal');
      const warnings = ['no-patient-warning', 'no-patient-warning-realtime', 'no-patient-warning-analysis', 'log-no-patient', 'data-no-patient'];
      warnings.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'block';
      });

      const content = ['realtime-content', 'analysis-classification-content'];
      content.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });

      updateMVCDisplay(null, null);
      loadAllData();
      document.getElementById('log-patient-info').style.display = 'none'; // <-- TAMBAHKAN
      document.getElementById('rehab-patient-info').style.display = 'none';
    }

    function loadFilteredData() {
      if (!selectedPatient) return;

      const patientName = selectedPatient.name;
      loadLogActivitiesForPatient(patientName);
      loadRehabDataForPatient(patientName);
    }

    // Fungsi untuk konversi point -> grade (pakai konsep lama)
    function getGradeByPoints(points) {
      if (points >= 1.5) return { grade: "A", icon: "🏆" };
      if (points >= 1.0) return { grade: "B", icon: "👍" };
      if (points >= 0.5) return { grade: "C", icon: "🙂" };
      return { grade: "D", icon: "⚠️" };
    }

    // ------------------- Load Log Activities -------------------
    async function loadLogActivitiesForPatient(patientName) {
      const logTable = document.getElementById('log-aktivitas-table');
      updateLogPatientInfo(patientName);
      logTable.innerHTML = '<tr><td colspan="13" class="text-center py-4 text-slate-400">🔄 Memuat data...</td></tr>';

      try {
        // Ambil gender pasien
        const regSnapshot = await database.ref('patient_registrations')
          .orderByChild('name')
          .equalTo(patientName)
          .once('value');
        let patientGender = 'Tidak Diketahui';
        if (regSnapshot.exists()) {
          regSnapshot.forEach(child => {
            if (child.val().gender) patientGender = child.val().gender;
          });
        }

        // Ambil data rehab
        const snapshot = await database.ref('rehabilitation')
          .orderByChild('name')
          .equalTo(patientName)
          .once('value');
        logTable.innerHTML = '';
        if (!snapshot.exists()) {
          logTable.innerHTML = '<tr><td colspan="13" class="text-center py-8 text-slate-400">📝 Belum ada data aktivitas untuk pasien ini</td></tr>';
          return;
        }

        const activities = [];
        snapshot.forEach(child => {
          const data = child.val();
          data.firebaseKey = child.key;
          activities.push({ ...data, gender: patientGender });
        });

        // Sort terbaru
        activities.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0) || (Number(b.rehabSession) || 0) - (Number(a.rehabSession) || 0));

        logAllData = activities;
        logTotalItems = activities.length;
        logCurrentPage = 1;

        const pageData = logAllData.slice(0, logItemsPerPage);
        for (const data of pageData) {
          const duration = data.sessionDuration ? formatDuration(data.sessionDuration) : '-';
          const mvcReference = data.mvcReference || await getPatientMVCReference(data.name) || currentMVCReference;

          // Hitung %MVC & ROM
          const percentMVC = convertEMGToPercentage(data.avgRMSEMG || 0, mvcReference);
          const rmsDisplay = formatEMGDisplay(data.avgRMSEMG || 0, 'raw');
          const percentMVCDisplay = formatEMGDisplay(percentMVC, 'percentage');

          let romValueRaw = data.totalROM || data.avgAngle || 0;
          if (data.maxFlexion) romValueRaw = Math.max(parseFloat(romValueRaw), parseFloat(data.maxFlexion));
          let romValue = (typeof romValueRaw === "string" && romValueRaw.includes("-"))
            ? Math.max(...romValueRaw.split("-").map(x => parseFloat(x.trim())))
            : parseFloat(romValueRaw) || 0;

          // Hitung point ROM & EMG terpisah
          const romPoints = romValue >= 120 ? 1.5 : (romValue >= 90 ? 1.0 : (romValue >= 60 ? 0.5 : 0));
          const emgPoints = percentMVC >= 60 ? 1.5 : (percentMVC >= 40 ? 1.0 : (percentMVC >= 20 ? 0.5 : 0));

          // Grade per aspek
          const romGrade = getGradeByPoints(romPoints);
          const rmsGrade = getGradeByPoints(emgPoints);

          // Render baris tabel
          const row = logTable.insertRow();
          row.innerHTML = `
    <td class="col-nama" style="text-align: left; font-weight: 500;">${data.name}</td>
    <td style="text-align: center; font-weight: 600; color: #3b82f6;">${data.rehabSession}</td>
    <td style="text-align: center; font-weight: 600; color: #8b5cf6;">${duration}</td>
    <td style="text-align: center; font-weight: 600; color: #10b981;">
        ${(data.maxExtension || 0).toFixed(1)} - ${(data.maxFlexion || data.totalROM || data.avgAngle || 0).toFixed(1)}°
    </td>
    <td style="text-align: center; font-weight: 600; color: #22c55e;">
        ${data.maxFlexion ? data.maxFlexion.toFixed(1) + '°' : '0.0'}
    </td>
    <td style="text-align: center; font-weight: 600; color: #3b82f6;">
        ${data.maxExtension ? Math.abs(data.maxExtension).toFixed(1) + '°' : '0.0'}
    </td>
    <td style="text-align: center; font-weight: 600; color: #10b981;">${rmsDisplay}</td>
    <td style="text-align: center; font-weight: 600; color: #ef4444;">${percentMVCDisplay}</td>
    <td style="text-align: center; font-weight: 600; color: #f59e0b;">${(data.mvcReference || currentMVCReference || EMG_CONSTANTS.DEFAULT_MVC_REFERENCE).toFixed(1)} mV</td>
    <td style="text-align: center; font-weight: 600;">${romGrade.grade} ${romGrade.icon}</td>
    <td style="text-align: center; font-weight: 600;">${rmsGrade.grade} ${rmsGrade.icon}</td>
    <td style="text-align: center;">
        <button onclick="editRehabData('${data.firebaseKey}', '${data.name.replace(/'/g, "\\'")}', '${data.rehabSession}', '${data.date}', '${data.avgAngle || 0}', ${percentMVC.toFixed(1)}, '${data.avgMAVEMG || 0}', '${data.sessionDuration || 0}')" class="btn-warning mr-2" style="padding: 4px 8px; font-size: 12px;">
            <i class="fas fa-edit"></i>
        </button>
        <button onclick="deleteRehabData('${data.firebaseKey}', '${data.name}', ${data.rehabSession})" class="btn-danger" style="padding: 4px 8px; font-size: 12px;">
            <i class="fas fa-trash"></i>
        </button>
    </td>
`;


        }
      } catch (err) {
        console.error(err);
        logTable.innerHTML = '<tr><td colspan="13" class="text-center text-red-400">❌ Gagal memuat data</td></tr>';
      }
    }
    async function loadRehabDataForPatient(patientName) {
      const rehabTable = document.getElementById('rehab-data-table');
      updateRehabPatientInfo(patientName);
      rehabTable.innerHTML = '<tr><td colspan="13" class="text-center py-4 text-slate-400">🔄 Memuat data...</td></tr>';

      try {
        // Ambil gender pasien
        const regSnapshot = await database.ref('patient_registrations')
          .orderByChild('name')
          .equalTo(patientName)
          .once('value');
        let patientGender = 'Tidak Diketahui';
        if (regSnapshot.exists()) {
          regSnapshot.forEach(child => {
            if (child.val().gender) patientGender = child.val().gender;
          });
        }

        // Ambil data rehab
        const snapshot = await database.ref('rehabilitation')
          .orderByChild('name')
          .equalTo(patientName)
          .once('value');
        rehabTable.innerHTML = '';
        if (!snapshot.exists()) {
          rehabTable.innerHTML = '<tr><td colspan="13" class="text-center py-8 text-slate-400">📝 Belum ada data rehabilitasi untuk pasien ini</td></tr>';
          return;
        }

        const activities = [];
        snapshot.forEach(child => {
          const data = child.val();
          data.firebaseKey = child.key;
          activities.push({ ...data, gender: patientGender });
        });

        // Sort terbaru
        activities.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0) || (Number(b.rehabSession) || 0) - (Number(a.rehabSession) || 0));

        rehabAllData = activities;
        rehabTotalItems = activities.length;
        rehabCurrentPage = 1;

        const pageData = rehabAllData.slice(0, rehabItemsPerPage);
        for (const data of pageData) {
          const duration = data.sessionDuration ? formatDuration(data.sessionDuration) : '-';
          const mvcReference = data.mvcReference || await getPatientMVCReference(data.name) || currentMVCReference;

          // Hitung %MVC & ROM
          const percentMVC = convertEMGToPercentage(data.avgRMSEMG || 0, mvcReference);
          const rmsDisplay = formatEMGDisplay(data.avgRMSEMG || 0, 'raw');
          const percentMVCDisplay = formatEMGDisplay(percentMVC, 'percentage');

          let romValueRaw = data.totalROM || data.avgAngle || 0;
          if (data.maxFlexion) romValueRaw = Math.max(parseFloat(romValueRaw), parseFloat(data.maxFlexion));
          let romValue = (typeof romValueRaw === "string" && romValueRaw.includes("-"))
            ? Math.max(...romValueRaw.split("-").map(x => parseFloat(x.trim())))
            : parseFloat(romValueRaw) || 0;

          // Hitung point ROM & EMG terpisah
          const romPoints = romValue >= 120 ? 1.5 : (romValue >= 90 ? 1.0 : (romValue >= 60 ? 0.5 : 0));
          const emgPoints = percentMVC >= 60 ? 1.5 : (percentMVC >= 40 ? 1.0 : (percentMVC >= 20 ? 0.5 : 0));

          // Grade per aspek
          const romGrade = getGradeByPoints(romPoints);
          const rmsGrade = getGradeByPoints(emgPoints);

          // Render baris tabel
          const row = rehabTable.insertRow();
          row.innerHTML = `
    <td class="col-nama" style="text-align: left; font-weight: 500;">${data.name}</td>
    <td class="col-tanggal" style="text-align: center;">${new Date(data.date).toLocaleDateString('id-ID')}</td>
    <td style="text-align: center; font-weight: 600; color: #3b82f6;">${data.rehabSession}</td>
    <td style="text-align: center; font-weight: 600; color: #8b5cf6;">${duration}</td>
    <td style="text-align: center; font-weight: 600; color: #10b981;">
        ${(data.maxExtension || 0).toFixed(1)} - ${(data.maxFlexion || data.totalROM || data.avgAngle || 0).toFixed(1)}°
    </td>
    <td style="text-align: center; font-weight: 600; color: #22c55e;">
        ${data.maxFlexion ? data.maxFlexion.toFixed(1) + '°' : '0.0'}
    </td>
    <td style="text-align: center; font-weight: 600; color: #3b82f6;">
        ${data.maxExtension ? Math.abs(data.maxExtension).toFixed(1) + '°' : '0.0'}
    </td>
    <td style="text-align: center; font-weight: 600; color: #10b981;">${rmsDisplay}</td>
    <td style="text-align: center; font-weight: 600; color: #ef4444;">${percentMVCDisplay}</td>
    <td style="text-align: center; font-weight: 600; color: #f59e0b;">${(data.mvcReference || currentMVCReference || EMG_CONSTANTS.DEFAULT_MVC_REFERENCE).toFixed(1)} mV</td>
    <td style="text-align: center; font-weight: 600;">${romGrade.grade} ${romGrade.icon}</td>
    <td style="text-align: center; font-weight: 600;">${rmsGrade.grade} ${rmsGrade.icon}</td>
`;
        }
      } catch (err) {
        console.error(err);
        rehabTable.innerHTML = '<tr><td colspan="13" class="text-center text-red-400">❌ Gagal memuat data</td></tr>';
      }
    }


    function updateRehabPatientInfo(patientName) {
      const infoContainer = document.getElementById('rehab-patient-info');
      if (!patientName) {
        infoContainer.style.display = 'none';
        return;
      }
      database.ref('patient_registrations')
        .orderByChild('name')
        .equalTo(patientName)
        .once('value')
        .then(snapshot => {
          if (snapshot.exists()) {
            let patientData = null;
            snapshot.forEach(child => {
              patientData = child.val();
            });
            if (patientData) {
              document.getElementById('rehab-patient-name').textContent = patientData.name || '-';
              document.getElementById('rehab-patient-age').textContent = (patientData.age || '?') + ' tahun';
              document.getElementById('rehab-patient-gender').textContent = patientData.gender || 'Tidak Diketahui';
              document.getElementById('rehab-patient-weight').textContent = patientData.weight ? patientData.weight + ' kg' : '-';
              document.getElementById('rehab-patient-height').textContent = patientData.height ? patientData.height + ' cm' : '-';

              infoContainer.style.display = 'block';
            } else {
              infoContainer.style.display = 'none';
            }
          } else {
            infoContainer.style.display = 'none';
          }
        })
        .catch(() => {
          infoContainer.style.display = 'none';
        });
    }
    function updateLogPatientInfo(patientName) {
      const infoContainer = document.getElementById('log-patient-info');
      if (!patientName) {
        infoContainer.style.display = 'none';
        return;
      }
      // Ambil data pasien dari registrasi
      database.ref('patient_registrations')
        .orderByChild('name')
        .equalTo(patientName)
        .once('value')
        .then(snapshot => {
          if (snapshot.exists()) {
            let patientData = null;
            snapshot.forEach(child => {
              patientData = child.val();
            });
            if (patientData) {
              document.getElementById('log-patient-name').textContent = patientData.name || '-';
              document.getElementById('log-patient-gender').textContent = patientData.gender || 'Tidak Diketahui';
              document.getElementById('log-patient-weight').textContent = patientData.weight ? patientData.weight + ' kg' : '-';
              document.getElementById('log-patient-height').textContent = patientData.height ? patientData.height + ' cm' : '-';

              // ✅ PERBAIKAN: Ganti 'log-patient-dob' → 'log-patient-age'
              const age = patientData.age || '?';
              document.getElementById('log-patient-age').textContent = `${age} tahun`;

              infoContainer.style.display = 'block';
            } else {
              infoContainer.style.display = 'none';
            }
          } else {
            infoContainer.style.display = 'none';
          }
        })
        .catch(() => {
          infoContainer.style.display = 'none';
        });
    }
    function loadAllData() {
      loadAllLogActivities();
      loadAllRehabData();
    }

    function loadAllLogActivities() {
      const logTable = document.getElementById('log-aktivitas-table');
      logTable.innerHTML = '<tr><td colspan="12" class="text-center py-4 text-slate-400">🔄 Memuat semua data...</td></tr>';

      // Ambil data registrasi pasien dulu untuk gender
      database.ref('patient_registrations').once('value', regSnapshot => {
        const patientGenderMap = new Map();
        if (regSnapshot.exists()) {
          regSnapshot.forEach(child => {
            const regData = child.val();
            patientGenderMap.set(regData.name, regData.gender || 'Tidak Diketahui');
          });
        }

        // Ambil semua data rehabilitasi
        database.ref('rehabilitation').once('value', snapshot => {
          logTable.innerHTML = '';

          if (!snapshot.exists()) {
            logTable.innerHTML = '<tr><td colspan="12" class="text-center py-8 text-slate-400">📝 Belum ada data aktivitas</td></tr>';
            return;
          }

          const activities = [];
          snapshot.forEach(child => {
            const data = child.val();
            data.firebaseKey = child.key;
            activities.push(data);
          });

          // Sort by date desc, session desc
          activities.sort((a, b) => {
            const dateDiff = new Date(b.date || 0) - new Date(a.date || 0);
            if (dateDiff !== 0) return dateDiff;
            return (Number(b.rehabSession) || 0) - (Number(a.rehabSession) || 0);
          });

          // Tambahkan gender
          logAllData = activities.map(data => ({
            ...data,
            gender: patientGenderMap.get(data.name) || 'Tidak Diketahui'
          }));
          logTotalItems = logAllData.length;
          logCurrentPage = 1;

          const paginationElement = document.getElementById('log-pagination');
          paginationElement.style.display = logTotalItems > logItemsPerPage ? 'block' : 'none';

          displayLogPage(); // panggil halaman pertama
          updateComprehensiveStatistics(logAllData); // update statistik keseluruhan
        }).catch(error => {
          console.error("Error loading all log activities:", error);
          logTable.innerHTML = '<tr><td colspan="12" class="text-center py-4 text-red-400">❌ Gagal memuat data</td></tr>';
        });
      });
    }

    function loadAllRehabData() {
      const rehabTable = document.getElementById('rehab-data-table');
      rehabTable.innerHTML = '<tr><td colspan="12" class="text-center py-4 text-slate-400">🔄 Memuat semua data...</td></tr>';

      // Ambil data registrasi pasien dulu untuk gender
      database.ref('patient_registrations').once('value', regSnapshot => {
        const patientGenderMap = new Map();
        if (regSnapshot.exists()) {
          regSnapshot.forEach(child => {
            const regData = child.val();
            patientGenderMap.set(regData.name, regData.gender || 'Tidak Diketahui');
          });
        }

        // Ambil semua data rehabilitasi
        database.ref('rehabilitation').once('value', snapshot => {
          rehabTable.innerHTML = '';
          if (!snapshot.exists()) {
            rehabTable.innerHTML = '<tr><td colspan="12" class="text-center py-8 text-slate-400">📊 Belum ada data rehabilitasi</td></tr>';
            updateComparisonChart([]);
            return;
          }

          const allData = [];
          snapshot.forEach(child => {
            const data = child.val();
            allData.push({ ...data, gender: patientGenderMap.get(data.name) || 'Tidak Diketahui' });
          });

          // Sort by date desc, session desc
          rehabAllData = allData.sort((a, b) => {
            const dateDiff = new Date(b.date || 0) - new Date(a.date || 0);
            if (dateDiff !== 0) return dateDiff;
            return (Number(b.rehabSession) || 0) - (Number(a.rehabSession) || 0);
          });
          allRehabData = [...rehabAllData];

          rehabTotalItems = rehabAllData.length;
          rehabCurrentPage = 1;

          const paginationElement = document.getElementById('rehab-pagination');
          paginationElement.style.display = rehabTotalItems > rehabItemsPerPage ? 'block' : 'none';

          displayRehabPage(); // panggil halaman pertama
          updateComparisonChart(rehabAllData);
          updateComprehensiveStatistics(rehabAllData);
        }).catch(error => {
          console.error("Error loading all rehab data:", error);
          rehabTable.innerHTML = '<tr><td colspan="12" class="text-center py-4 text-red-400">❌ Gagal memuat data</td></tr>';
        });
      });
    }


    // CHART INITIALIZATION MOVED TO createChartInstances() function above
    // No duplicate chart initialization code here

    const combinedAnalysisChart = new Chart(document.getElementById('combined-analysis-chart'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'RMS (mV)',
            data: [],
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            fill: false,
            tension: 0.4,
            pointRadius: 2,
            pointHoverRadius: 4,
            yAxisID: 'y'
          },
          {
            label: 'Variance',
            data: [],
            borderColor: '#f59e0b',
            backgroundColor: 'rgba(245, 158, 11, 0.1)',
            fill: false,
            tension: 0.4,
            pointRadius: 2,
            pointHoverRadius: 4,
            yAxisID: 'y1'
          },
          {
            label: 'Waveform Length',
            data: [],
            borderColor: '#a78bfa',
            backgroundColor: 'rgba(167, 139, 250, 0.1)',
            fill: false,
            tension: 0.4,
            pointRadius: 2,
            pointHoverRadius: 4,
            yAxisID: 'y'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            labels: {
              color: '#e2e8f0',
            }
          },
          title: {
            display: true,
            text: 'Fitur Analisis Real-time',
            color: '#e2e8f0'
          }
        },
        scales: {
          x: {
            ticks: { color: '#94a3b8' },
            grid: { color: 'rgba(148, 163, 184, 0.1)' }
          },
          y: {
            beginAtZero: true,
            position: 'left',
            ticks: {
              color: '#94a3b8',
              callback: function (value) {
                return value.toFixed(2) + '%';
              }
            },
            grid: { color: 'rgba(148, 163, 184, 0.1)' },
            title: {
              display: true,
              text: 'RMS & MAV (mV)',
              color: '#e2e8f0'
            }
          },
          y1: {
            beginAtZero: true,
            position: 'right',
            ticks: {
              color: '#94a3b8',
              callback: function (value) {
                return value.toFixed(4);
              }
            },
            grid: {
              drawOnChartArea: false,
            },
            title: {
              display: true,
              text: 'Variance',
              color: '#f59e0b'
            }
          }
        }
      }
    });

    const classificationChart = new Chart(document.getElementById('classification-chart'), {
      type: 'bar',
      data: {
        labels: ['🏆 Grade A', '👍 Grade B', '⚠️ Grade C', '🔴 Grade D'],
        datasets: [{
          label: 'Jumlah Samples',
          data: [0, 0, 0, 0],
          backgroundColor: [
            'rgba(34, 197, 94, 0.8)',
            'rgba(59, 130, 246, 0.8)',
            'rgba(245, 158, 11, 0.8)',
            'rgba(239, 68, 68, 0.8)'
          ],
          borderColor: [
            'rgb(34, 197, 94)',
            'rgb(59, 130, 246)',
            'rgb(245, 158, 11)',
            'rgb(239, 68, 68)'
          ],
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          },
          title: {
            display: true,
            text: 'Distribusi Klasifikasi Kinerja Gabungan Real-time',
            color: '#e2e8f0'
          }
        },
        scales: {
          x: {
            ticks: { color: '#94a3b8' },
            grid: { color: 'rgba(148, 163, 184, 0.1)' }
          },
          y: {
            beginAtZero: true,
            ticks: {
              color: '#94a3b8',
              stepSize: 1
            },
            grid: { color: 'rgba(148, 163, 184, 0.1)' },
            title: {
              display: true,
              text: 'Jumlah Samples',
              color: '#e2e8f0'
            }
          }
        }
      }
    });

    const comparisonChart = new Chart(document.getElementById('comparison-chart'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'ROM (°)',
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            data: [],
            tension: 0.4,
            yAxisID: 'y'
          },
          {
            label: 'RMS EMG (%MVC)',
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            data: [],
            tension: 0.4,
            yAxisID: 'y1'
          },
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            labels: {
              color: '#e2e8f0'
            }
          },
          tooltip: {
            callbacks: {
              label: function (context) {
                if (context.datasetIndex === 0) {
                  return `ROM: ${context.parsed.y.toFixed(1)}°`;
                } else {
                  return `RMS EMG: ${context.parsed.y.toFixed(1)}% MVC`;
                }
              }
            }
          }
        },
        scales: {
          x: {
            ticks: {
              color: '#94a3b8',
              maxRotation: 45,
              maxTicksLimit: 8
            },
            grid: { color: 'rgba(148, 163, 184, 0.1)' }
          },
          y: {
            beginAtZero: true,
            position: 'left',
            ticks: {
              color: '#94a3b8',
              callback: function (value) {
                return value + '°';
              }
            },
            grid: { color: 'rgba(148, 163, 184, 0.1)' },
            title: {
              display: true,
              text: 'ROM (°)',
              color: '#3b82f6'
            }
          },
          y1: {
            beginAtZero: true,
            position: 'right',
            ticks: {
              color: '#94a3b8',
              callback: function (value) {
                return value + '%';
              }
            },
            grid: {
              drawOnChartArea: false,
            },
            title: {
              display: true,
              text: 'RMS EMG (%MVC)',
              color: '#10b981'
            }
          },
          y2: {
            beginAtZero: true,
            position: 'right',
            ticks: {
              color: '#94a3b8',
              callback: function (value) {
                return value + '%';
              }
            },
            display: false,
            title: {
              display: false
            }
          }
        }
      }
    });

    function updateComprehensiveStatistics(dataToAnalyze) {
      if (!dataToAnalyze || dataToAnalyze.length === 0) {
        const statElements = [
          'maxROM', 'minROM', 'avgROM', 'totalSessions', 'totalDuration',
          'avgDuration', 'maxRMSEMG', 'minRMSEMG', 'avgRMSEMG',
          'gradeROM_A_Count', 'gradeROM_B_Count', 'gradeROM_C_Count', 'gradeROM_D_Count',
          'gradeEMG_A_Count', 'gradeEMG_B_Count', 'gradeEMG_C_Count', 'gradeEMG_D_Count',
          'improvementTrend', 'consistencyRate'
        ];

        statElements.forEach(id => {
          const element = document.getElementById(id);
          if (element) element.textContent = '0';
        });
        return;
      }

      const romValues = dataToAnalyze.map(d => d.maxFlexion || d.avgAngle || 0);
      const rmsEMGValues = dataToAnalyze.map(d => d.avgRMSEMG || 0);
      const durations = dataToAnalyze.map(d => d.sessionDuration || 0);

      const maxROM = Math.max(...romValues);
      const minROM = Math.min(...romValues);
      const avgROM = romValues.reduce((a, b) => a + b, 0) / romValues.length;

      const maxRMSEMG = Math.max(...rmsEMGValues);
      const minRMSEMG = Math.min(...rmsEMGValues);
      const avgRMSEMG = rmsEMGValues.reduce((a, b) => a + b, 0) / rmsEMGValues.length;

      const totalDuration = durations.reduce((a, b) => a + b, 0);
      const avgDuration = totalDuration / durations.length;

      // ✅ HITUNG GRADE ROM DAN EMG TERPISAH
      const gradeCountROM = { A: 0, B: 0, C: 0, D: 0 };
      const gradeCountEMG = { A: 0, B: 0, C: 0, D: 0 };

      dataToAnalyze.forEach(d => {
        const mvcReference = getSafeMVCReference(d.mvcReference || currentMVCReference);
        const percentMVC = convertEMGToPercentage(d.avgRMSEMG || 0, mvcReference);

        // Hitung ROM value
        let romValue = d.maxFlexion || d.totalROM || d.avgAngle || 0;

        // Grade ROM berdasarkan sudut
        if (romValue >= 120) {
          gradeCountROM.A++;
        } else if (romValue >= 100) {
          gradeCountROM.B++;
        } else if (romValue >= 80) {
          gradeCountROM.C++;
        } else {
          gradeCountROM.D++;
        }

        // Grade EMG berdasarkan %MVC
        if (percentMVC >= 60) {
          gradeCountEMG.A++;
        } else if (percentMVC >= 45) {
          gradeCountEMG.B++;
        } else if (percentMVC >= 30) {
          gradeCountEMG.C++;
        } else {
          gradeCountEMG.D++;
        }
      });

      // ✅ UPDATE SEMUA STATISTIK
      document.getElementById('maxROM').textContent = maxROM.toFixed(1) + '°';
      document.getElementById('minROM').textContent = minROM.toFixed(1) + '°';
      document.getElementById('avgROM').textContent = avgROM.toFixed(1) + '°';

      document.getElementById('maxRMSEMG').textContent = maxRMSEMG.toFixed(1) + ' mV';
      document.getElementById('minRMSEMG').textContent = minRMSEMG.toFixed(1) + ' mV';
      document.getElementById('avgRMSEMG').textContent = avgRMSEMG.toFixed(1) + ' mV';

      // ✅ UPDATE GRADE ROM
      updateIfExists('gradeROM_A_Count', gradeCountROM.A);
      updateIfExists('gradeROM_B_Count', gradeCountROM.B);
      updateIfExists('gradeROM_C_Count', gradeCountROM.C);
      updateIfExists('gradeROM_D_Count', gradeCountROM.D);

      // ✅ UPDATE GRADE EMG
      updateIfExists('gradeEMG_A_Count', gradeCountEMG.A);
      updateIfExists('gradeEMG_B_Count', gradeCountEMG.B);
      updateIfExists('gradeEMG_C_Count', gradeCountEMG.C);
      updateIfExists('gradeEMG_D_Count', gradeCountEMG.D);

      // Hitung improvement trend dan consistency
      let improvementTrend = "Stabil";
      if (dataToAnalyze.length >= 10) {
        const firstFive = dataToAnalyze.slice(0, 5).map(d => d.avgAngle || 0);
        const lastFive = dataToAnalyze.slice(-5).map(d => d.avgAngle || 0);
        const firstAvg = firstFive.reduce((a, b) => a + b, 0) / firstFive.length;
        const lastAvg = lastFive.reduce((a, b) => a + b, 0) / lastFive.length;

        const improvement = ((lastAvg - firstAvg) / firstAvg) * 100;
        if (improvement > 10) improvementTrend = "Meningkat";
        else if (improvement < -10) improvementTrend = "Menurun";
      }

      const consistencyRate = ((gradeCountROM.A + gradeCountROM.B) / dataToAnalyze.length) * 100;

      updateIfExists('totalSessions', dataToAnalyze.length + ' sesi');
      updateIfExists('totalDuration', formatDuration(totalDuration));
      updateIfExists('avgDuration', formatDuration(Math.floor(avgDuration)));
      updateIfExists('improvementTrend', improvementTrend);
      updateIfExists('consistencyRate', consistencyRate.toFixed(1) + '%');

      console.log('✅ Statistics updated:', {
        gradeROM: gradeCountROM,
        gradeEMG: gradeCountEMG
      });
    }

    // Helper function
    function updateIfExists(id, value) {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    }
    function updateComparisonChart(dataToUse = allRehabData) {
       console.log('=== updateComparisonChart START ===');

       if (!comparisonChart) {
         console.error('comparisonChart not initialized!');
         return;
       }

       if (!dataToUse || dataToUse.length === 0) {
         comparisonChart.data.labels = [];
         comparisonChart.data.datasets[0].data = [];
         comparisonChart.data.datasets[1].data = [];
         comparisonChart.update();
         return;
       }

      const sortedData = [...dataToUse].sort((a, b) => {
         const dateDiff = new Date(b.date || 0) - new Date(a.date || 0);
         if (dateDiff !== 0) return dateDiff;
         return (Number(b.rehabSession) || 0) - (Number(a.rehabSession) || 0);
       });

       const labels = sortedData.map(d => `${d.name} - S${d.rehabSession}`);
       // Tampilkan nilai ekstensi saja (nilai tertinggi dari ROM)
    const romValues = sortedData.map(d => {
      return d.maxFlexion || d.totalROM || d.avgAngle || 0;
    });

    //   // KONVERSI RMS KE %MVC - SAMA SEPERTI DI TABEL
       const rmsValues = sortedData.map((d, index) => {
         const rawRMS = d.avgRMSEMG || 0;

    //     // Gunakan MVC reference yang sama dengan perhitungan tabel
         const mvcRef = getSafeMVCReference(d.mvcReference || currentMVCReference);

    //     // Hitung %MVC - SAMA PERSIS SEPERTI DI FUNGSI convertEMGToPercentage
         const percentMVC = convertEMGToPercentage(rawRMS, mvcRef);

         console.log(`Chart Data ${index}: ${d.name}-S${d.rehabSession} | RMS=${rawRMS}mV | MVC=${mvcRef}mV | %MVC=${percentMVC}%`);

    //     return percentMVC;
       });

       // Clear dan set data chart
       comparisonChart.data.labels = labels;
       comparisonChart.data.datasets[0].data = romValues;
       comparisonChart.data.datasets[1].data = rmsValues;

    //   // Update scale
       const maxMVC = Math.max(...rmsValues);
       const chartMax = Math.max(200, Math.ceil(maxMVC / 50) * 50);
       comparisonChart.options.scales.y1.max = chartMax;

       console.log('Final chart data - ROM:', romValues);
       console.log('Final chart data - %MVC:', rmsValues);
       console.log('Chart scale max:', chartMax);

       comparisonChart.update();
       updateComprehensiveStatistics(dataToUse);

       console.log('=== updateComparisonChart END ===');
     }

    function updateComparisonChart(dataToUse = null) {
      console.log('=== updateComparisonChart START ===');
      if (!comparisonChart) {
        console.error('comparisonChart not initialized!');
        return;
      }

      // Jika ada pasien yang dipilih, filter hanya data pasien tersebut
      let filteredData = [];
      if (selectedPatient && selectedPatient.name) {
        const patientName = selectedPatient.name;
        filteredData = allRehabData.filter(d => d.name === patientName);
        console.log(`[Chart] Filtering data for patient: ${patientName}, found ${filteredData.length} records`);
      } else {
        // Jika tidak ada pasien aktif, tampilkan semua (opsional)
        filteredData = dataToUse || allRehabData;
      }

      if (!filteredData || filteredData.length === 0) {
        comparisonChart.data.labels = [];
        comparisonChart.data.datasets[0].data = [];
        comparisonChart.data.datasets[1].data = [];
        comparisonChart.update();
        updateComprehensiveStatistics([]);
        return;
      }

      // Urutkan data berdasarkan tanggal dan sesi
      const sortedData = [...filteredData].sort((a, b) => {
        const dateDiff = new Date(b.date || 0) - new Date(a.date || 0);
        if (dateDiff !== 0) return dateDiff;
        return (Number(b.rehabSession) || 0) - (Number(a.rehabSession) || 0);
      });

      const labels = sortedData.map(d => `Sesi ${d.rehabSession}`);

      // Tampilkan nilai ekstensi saja (nilai tertinggi dari ROM)
      const romValues = sortedData.map(d => {
        return d.maxFlexion || d.totalROM || d.avgAngle || 0;
      });

      // Konversi RMS ke %MVC
      const rmsValues = sortedData.map((d, index) => {
        const rawRMS = d.avgRMSEMG || 0;
        const mvcRef = getSafeMVCReference(d.mvcReference || currentMVCReference);
        const percentMVC = convertEMGToPercentage(rawRMS, mvcRef);
        console.log(`Chart Data ${index}: Sesi ${d.rehabSession} | RMS=${rawRMS}mV | MVC=${mvcRef}mV | %MVC=${percentMVC}%`);
        return percentMVC;
      });

      // Update chart
      comparisonChart.data.labels = labels;
      comparisonChart.data.datasets[0].data = romValues;
      comparisonChart.data.datasets[1].data = rmsValues;

      // Atur skala sumbu Y kanan
      const maxMVC = Math.max(...rmsValues);
      const chartMax = Math.max(200, Math.ceil(maxMVC / 50) * 50);
      comparisonChart.options.scales.y1.max = chartMax;

      comparisonChart.update();
      updateComprehensiveStatistics(filteredData);
      console.log('=== updateComparisonChart END ===');
    }
    // Helper function untuk deteksi jenis data
    function detectDataType(data) {
      const avgRMS = data.reduce((sum, d) => sum + (d.avgRMSEMG || 0), 0) / data.length;
      const hasProperMVC = data.some(d => d.mvcReference && d.mvcReference !== 1000);

      return {
        isOldData: avgRMS > 50 && !hasProperMVC,
        avgRMS: avgRMS,
        hasProperMVC: hasProperMVC,
        recommendedMVC: hasProperMVC ? null : avgRMS * 1.5 // Estimasi untuk data lama
      };
    }

    function clearSessionData() {
      currentSessionData = [];
      maxRMSEMG = 0; // Reset max RMS

      // Update display max RMS
      const maxRMSElement = document.getElementById('max-rms');
      if (maxRMSElement) {
        maxRMSElement.textContent = '0.00 mV';
      }
    }
    // Reset charts properly
    if (angleChart) {

      // Reset charts properly
      if (angleChart) {
        angleChart.data.labels = [];
        angleChart.data.datasets[0].data = [];
        angleChart.update();
      }

      if (emgChart) {
        emgChart.data.labels = [];
        emgChart.data.datasets[0].data = [];
        emgChart.data.datasets[1].data = [];
        emgChart.update();
      }

      // Reset ROM analysis
      romAnalysisData = {
        currentAngle: 0,
        angles: [],
        maxFlexion: 0,
        maxExtension: 0,
        totalROM: 0,
        consistency: 0
      };

      console.log('[Session] Session data and charts cleared');
    }

    function resetCharts() {
      console.log('[Charts] Manually resetting charts...');
      clearSessionData();
      initializeChartsWithCurrentTime();
    }

    function updateClassificationDisplay(classification) {
      const romGradeElement = document.getElementById('rom-grade');
      const emgGradeElement = document.getElementById('emg-grade');
      const romGradeStatusElement = document.getElementById('rom-grade-status');
      const emgGradeStatusElement = document.getElementById('emg-grade-status');
      const romGradeIconElement = document.getElementById('rom-grade-icon');
      const emgGradeIconElement = document.getElementById('emg-grade-icon');

      if (classification && classification.romGrade && classification.emgGrade) {
        // Update ROM Grade
        if (romGradeElement) romGradeElement.textContent = classification.romGrade;
        if (romGradeStatusElement) romGradeStatusElement.textContent = classification.romStatus;
        if (romGradeIconElement) romGradeIconElement.textContent = classification.romIcon;

        // Update EMG Grade
        if (emgGradeElement) emgGradeElement.textContent = classification.emgGrade;
        if (emgGradeStatusElement) emgGradeStatusElement.textContent = classification.emgStatus;
        if (emgGradeIconElement) emgGradeIconElement.textContent = classification.emgIcon;

        console.log('[Classification] Updated - ROM:', classification.romGrade, 'EMG:', classification.emgGrade);
      } else {
        // Reset ke N/A
        if (romGradeElement) romGradeElement.textContent = 'N/A';
        if (emgGradeElement) emgGradeElement.textContent = 'N/A';
        if (romGradeStatusElement) romGradeStatusElement.textContent = 'Menunggu data...';
        if (emgGradeStatusElement) emgGradeStatusElement.textContent = 'Menunggu data...';
      }
    }

    function updateEnhancedClassificationDisplay(classification) {
      const gradeElement = document.getElementById('classification-grade');
      const statusElement = document.getElementById('classification-status');
      const descriptionElement = document.getElementById('classification-description');
      const iconElement = document.getElementById('grade-icon');
      const romScoreElement = document.getElementById('display-rom-score');
      const emgScoreElement = document.getElementById('display-emg-score');

      if (!gradeElement || !statusElement || !descriptionElement) return;

      if (classification && classification.grade) {
        // Update main display
        gradeElement.textContent = classification.grade;
        statusElement.textContent = `${classification.status} (${classification.totalPoints}/3.0 poin)`;
        descriptionElement.textContent = classification.description;

        // Update icon with emoji
        if (iconElement) iconElement.textContent = classification.icon || '';
        gradeElement.className = `font-bold text-7xl ${getGradeColor(classification.grade)}`;

        // Update score breakdown
        if (romScoreElement) romScoreElement.textContent = classification.romScore + '/1.5 (ROM)';
        if (emgScoreElement) emgScoreElement.textContent = classification.emgScore + '/1.5 (EMG)';

        // Add visual indicators if available
        if (classification.detailedBreakdown) {
          const breakdown = classification.detailedBreakdown;
          // Update ROM indicator
          const romIndicator = document.getElementById('rom-category-indicator');
          if (romIndicator) {
            romIndicator.textContent = breakdown.rom.emoji;
            romIndicator.className = 'text-lg mr-2';
          }
        }
      } else {
        // Reset to default state
        gradeElement.textContent = 'N/A';
        statusElement.textContent = 'Menunggu data...';
        descriptionElement.textContent = 'Menunggu data ROM dan EMG untuk klasifikasi gabungan.';
        if (iconElement) iconElement.textContent = '';
        gradeElementclassName = 'font-bold text-7xl text-slate-400';
        if (combinedScoreElement) combinedScoreElement.textContent = '0.0/4.0';
      }
    }
    function exportEnhancedAnalysisToPDF() {
      try {
        console.log("➡️ selectedPatient:", selectedPatient);
        console.log("➡️ currentSessionData:", currentSessionData);
        console.log("➡️ romAnalysisData:", romAnalysisData);
        console.log("➡️ currentMVCReference:", currentMVCReference);

        if (!selectedPatient || !currentSessionData || currentSessionData.length === 0) {
          alert('⚠️ Tidak ada data sesi untuk diekspor!');
          return;
        }
        if (!romAnalysisData) {
          alert('⚠️ Data ROM belum tersedia!');
          return;
        }
        if (typeof currentMVCReference === "undefined") {
          alert('⚠️ Referensi MVC belum tersedia!');
          return;
        }

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF('landscape', 'mm', 'a4');

        // ---------------- HEADER ----------------
        const pageWidth = pdf.internal.pageSize.width;
        const pageHeight = pdf.internal.pageSize.height;

        pdf.setFillColor(25, 46, 85);
        pdf.rect(0, 0, pageWidth, 55, 'F');
        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(28);
        pdf.setFont(undefined, 'bold');
        pdf.text('Laporan Analisis Gabungan', 20, 24);
        pdf.setFontSize(14);
        pdf.setFont(undefined, 'normal');
        pdf.text(
          `Pasien: ${selectedPatient.name} | Sesi: ${selectedPatient.rehabSession} | Tanggal: ${new Date().toLocaleDateString('id-ID')}`,
          20,
          35
        );
        pdf.setFontSize(10);
        pdf.text(`MVC Reference: ${currentMVCReference.toFixed(2)} mV`, 20, 42);

        // ---------------- DATA ----------------
        const romStats = {
          currentAngle: romAnalysisData.currentAngle,
          maxFlexion: romAnalysisData.maxFlexion,
          maxExtension: romAnalysisData.maxExtension,
          totalROM: romAnalysisData.totalROM,
          consistency: romAnalysisData.consistency
        };

        const latestData = currentSessionData[currentSessionData.length - 1];
        const emgFeaturesInMVC = {
          rms: latestData.rmsEMG,
          mav: latestData.mavEMG,
          variance: 0,
          waveformLength: 0,
          zeroCrossings: 0,
          slopeSignChanges: 0
        };
        function classifyRehabilitationPerformanceCountBased(emgFeatures, romStats, mvcReference) {
          // Atur bobot sesuai kebutuhan
          let score = 0;

          // Contoh kriteria sederhana
          if (romStats.totalROM > 90) score += 1;         // Fleksibilitas
          if (romStats.consistency > 70) score += 1;      // Konsistensi
          if (emgFeatures.rms > 30) score += 1;           // Aktivasi otot

          // Bisa tambahkan logika lain...
          let grade, status, description;
          if (score >= 3) {
            grade = "A";
            status = "Excellent";
            description = "Semua parameter sangat baik";
          } else if (score >= 2) {
            grade = "B";
            status = "Good";
            description = "Sebagian besar parameter baik";
          } else if (score >= 1) {
            grade = "C";
            status = "Fair";
            description = "Hanya satu parameter baik";
          } else {
            grade = "D";
            status = "Poor";
            description = "Perlu latihan lebih intensif";
          }

          return {
            grade,
            status,
            combinedScore: score,
            description
          };
        }

        const classification = classifyRehabilitationPerformanceCountBased(
          emgFeaturesInMVC,
          romStats,
          currentMVCReference
        );

        let y = 60;

        pdf.setFontSize(16);
        pdf.setTextColor(51, 65, 85);
        pdf.text('Ringkasan Hasil', 20, y);
        pdf.setDrawColor(200, 200, 200);
        pdf.line(20, y + 2, pageWidth - 20, y + 2);
        y += 10;

        const summaryTable = [
          ['Kategori', 'Hasil', 'Keterangan'],
          ['Grade Klasifikasi', classification.grade, classification.status],
          ['Combined Score', `${classification.combinedScore}/4.0`, classification.description],
          ['ROM Rentang', `${(romStats.maxExtension || 0).toFixed(1)}-${(romStats.maxFlexion || romStats.totalROM || 0).toFixed(1)}°`,
            `Fleksi: ${(romStats.maxFlexion || 0).toFixed(1)}°, Ekstensi: ${(romStats.maxExtension || 0).toFixed(1)}°`],
          ['ROM Konsistensi', `${(romStats.consistency || 0).toFixed(1)}%`, 'Stabilitas pola gerakan'],
          ['Aktivasi EMG', `${(emgFeaturesInMVC.rms || 0).toFixed(1)}% MVC`,
            `Berdasarkan RMS (${((emgFeaturesInMVC.rms || 0) * (currentMVCReference || 0) / 100).toFixed(2)} mV) terhadap MVC Ref (${(currentMVCReference || 0).toFixed(2)} mV)`]
        ];

        if (typeof pdf.autoTable !== "function") {
          alert("❌ Plugin AutoTable belum ter-load. Tambahkan script jsPDF AutoTable di HTML!");
          return;
        }

        pdf.autoTable({
          startY: y,
          head: [summaryTable[0]],
          body: summaryTable.slice(1),
          theme: 'striped',
          margin: { left: 20 },
          styles: { fontSize: 10, cellPadding: 3 },
          headStyles: {
            fillColor: [51, 65, 85],
            textColor: [255, 255, 255],
            fontStyle: 'bold'
          }
        });
        y = pdf.lastAutoTable.finalY + 15;

        // ---------------- KRITERIA ----------------
        pdf.setFontSize(16);
        pdf.setTextColor(51, 65, 85);
        pdf.text('Kriteria Klasifikasi', 20, y);
        pdf.line(20, y + 2, pageWidth - 20, y + 2);
        y += 10;

        const criteriaText = [
          `Grade A (Excellent - 3/3 poin): Semua parameter terpenuhi sempurna`,
          `Grade B (Good - 2-2.5 poin): 2 parameter utama terpenuhi dengan baik`,
          `Grade C (Fair - 1-1.5 poin): 1 parameter terpenuhi, perlu perbaikan lainnya`,
          `Grade D (Poor - 0.5 poin): Hanya sedikit progress, perlu latihan intensif`,
          `Grade E (Very Poor - 0 poin): Tidak ada parameter terpenuhi, evaluasi ulang program`
        ];

        pdf.setFontSize(10);
        pdf.setTextColor(51, 65, 85);
        criteriaText.forEach(line => {
          pdf.text(line, 25, y);
          y += 6;
        });

        // ---------------- SAVE FILE ----------------
        const filename = `Analisis_Gabungan_${selectedPatient.name.replace(/\s+/g, '_')}_Sesi_${selectedPatient.rehabSession}_${new Date().toISOString().split('T')[0]}.pdf`;
        pdf.save(filename);
        alert(`✅ Laporan analisis gabungan berhasil diekspor: ${filename}`);

      } catch (err) {
        console.error("❌ Gagal export PDF:", err);
        alert("❌ Terjadi error saat membuat PDF. Cek console log!");
      }
    }


    function refreshAnalysisData() {
      if (!selectedPatient) {
        alert("⚠️ Silakan pilih pasien terlebih dahulu.");
        return;
      }
      if (!currentSessionData || currentSessionData.length === 0) {
        alert("⚠️ Belum ada data real-time untuk dianalisis. Mulai sesi terlebih dahulu.");
        return;
      }

      // CEK: Jika sesi sedang dijeda, tampilkan klasifikasi terakhir
      if (isPaused && lastValidClassification) {
        updateClassificationDisplay(lastValidClassification);
        console.log("[Analysis] Using last valid classification during pause.");
        alert('✅ Data analisis berhasil di-refresh (menggunakan data terakhir).');
        return;
      }

      // Jika sesi aktif (tidak dijeda), hitung ulang seperti biasa
      const latestData = currentSessionData[currentSessionData.length - 1];
      const romStats = {
        totalROM: romAnalysisData.totalROM,
        consistency: romAnalysisData.consistency
      };
      const emgFeaturesInMVC = {
        rms: latestData.rmsEMG,
        mav: latestData.mavEMG,
        variance: 0,
        waveformLength: 0,
        zeroCrossings: 0,
        slopeSignChanges: 0
      };
      const classification = classifyRehabilitationPerformanceMVC(
        emgFeaturesInMVC,
        romStats,
        currentMVCReference
      );

      // Simpan juga hasil hitung ulang ini sebagai yang terakhir
      lastValidClassification = classification;

      updateClassificationDisplay(classification);
      updateRealtimeFeatureDisplayMVC(emgFeaturesInMVC, latestData);
      updateCombinedAnalysisChart();
      updateClassificationChart();
      alert('✅ Data analisis berhasil di-refresh.');
    }

    function resetCharts() {
      clearSessionData();
      updateClassificationDisplay(null);
      updateRealtimeFeatureDisplayMVC({ rms: 0, mav: 0, variance: 0, waveformLength: 0, zeroCrossings: 0, slopeSignChanges: 0 }, { mvcReference: currentMVCReference });
      alert('✅ Grafik dan metrik real-time berhasil di-reset.');
    }

    function initializeApp() {
      console.log('Initializing application...');
      loadAllData();
    }

    window.addEventListener('load', () => {
      initializeApp();
      const dateInput = document.getElementById('new-patient-date');
      if (dateInput) {
        const today = new Date().toISOString().split('T')[0];
        dateInput.value = today;
      }
      updateConnectionStatus(false, 'Ready to connect');
    });

    function formatDuration(seconds) {
      if (!seconds || seconds === 0) return '00:00:00';
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    // processMVCCalibrationResults function removed - now handled directly in Firebase listener

    function startMVCCalibration() {
      if (!selectedPatient) {
        alert('Pilih pasien terlebih dahulu!');
        return;
      }

      if (isSessionActive) {
        alert('Tidak dapat memulai kalibrasi saat sesi sedang berjalan!');
        return;
      }

      if (!confirm(`🔧 Mulai kalibrasi MVC untuk ${selectedPatient.name}?`)) return;

      // Start the calibration process
      startEMGCalibration();
    }

    function updateRealtimeFeatureDisplayMVC(emgFeaturesInMVC, latestData) {
      if (!latestData || !emgFeaturesInMVC) return;

      const setTextIfExists = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
      };

      // Update basic EMG displays
      const rawRMS = convertPercentageToEMG(emgFeaturesInMVC.rms, currentMVCReference);
      setTextIfExists('display-rms', formatEMGDisplay(rawRMS, 'raw'));

      // Update muscle activation percentage
      const activationLevel = Math.min(Math.max(emgFeaturesInMVC.rms, 0), 100);
      setTextIfExists('display-muscle-activation', `${activationLevel.toFixed(1)}%`);

      // Update advanced EMG features if available
      if (latestData.variance !== undefined) setTextIfExists('display-variance', latestData.variance.toFixed(4));
      if (latestData.zeroCrossings !== undefined) setTextIfExists('display-zero-crossings', latestData.zeroCrossings.toString());
      if (latestData.waveformLength !== undefined) setTextIfExists('display-waveform-length', latestData.waveformLength.toFixed(2));

      // Update muscle coordination (based on consistency of EMG signals)
      const coordination = calculateMuscleCoordination(emgFeaturesInMVC);
      setTextIfExists('display-muscle-coordination', `${coordination.toFixed(1)}%`);

      // Update signal quality
      const signalQuality = calculateSignalQuality(emgFeaturesInMVC, latestData);
      setTextIfExists('display-signal-quality', signalQuality);

      // Update EMG consistency
      const emgConsistency = calculateEMGConsistency(emgFeaturesInMVC);
      setTextIfExists('display-emg-consistency', `${emgConsistency.toFixed(1)}%`);

      // Update MVC reference display
      const mvcRef = getSafeMVCReference(latestData.mvcReference || currentMVCReference);
      setTextIfExists('display-mvc-reference', formatEMGDisplay(mvcRef, 'raw'));
    }

    function calculateMuscleCoordination(emgFeatures) {
      // Simple coordination metric based on RMS/MAV ratio
      if (emgFeatures.mav > 0) {
        const ratio = emgFeatures.rms / emgFeatures.mav;
        return Math.min(ratio * 50, 100); // Scale to 0-100%
      }
      return 0;
    }

    function calculateSignalQuality(emgFeatures, latestData) {
      const rms = emgFeatures.rms || 0;
      if (rms < 5) return "Poor";
      if (rms < 15) return "Fair";
      if (rms < 30) return "Good";
      return "Excellent";
    }

    function calculateEMGConsistency(emgFeatures) {
      // Simple consistency metric based on signal stability
      const rms = emgFeatures.rms || 0;
      const mav = emgFeatures.mav || 0;

      if (rms === 0 && mav === 0) return 0;

      const consistency = Math.min((mav / (rms + 0.1)) * 80, 100);
      return Math.max(consistency, 0);
    }

    function convertEMGToMVC(emgValue, mvcReference = currentMVCReference) {
      // Use the centralized helper function for consistency
      return convertEMGToPercentage(emgValue, mvcReference);
    }
    function loadPatientMVCCalibration(patientName) {
      return new Promise((resolve) => {
        const patientKey = patientName.replace(/\s+/g, '_');
        database.ref(`mvc_calibration/${patientKey}`).once('value', snapshot => {
          const mvcData = snapshot.val();
          if (mvcData && mvcData.maxMVC) {
            currentMVCReference = mvcData.maxMVC;
            updateMVCDisplay(currentMVCReference, mvcData.calibrationDate);
            resolve(mvcData);
          } else {
            currentMVCReference = 100; // Default
            updateMVCDisplay(currentMVCReference, null);
            resolve(null);
          }
        });
      });
    }

    function updateMVCDisplay(mvcValue, calibrationDate) {
      const mvcStatusElement = document.getElementById('mvc-status');
      const mvcDisplayElement = document.getElementById('display-mvc-reference');

      if (!mvcStatusElement) {
        // UI section not present; safely return
        return;
      }

      if (mvcValue) {
        mvcStatusElement.style.display = 'block';
        const dateText = calibrationDate ? new Date(calibrationDate).toLocaleDateString('id-ID') : 'Belum dikalibrasi';
        mvcStatusElement.innerHTML = `<i class="fas fa-check-circle text-green-400"></i> MVC Aktif: <span class="font-bold">${mvcValue.toFixed(2)} mV</span> (Tgl: ${dateText})`;
        if (mvcDisplayElement) mvcDisplayElement.textContent = `${mvcValue.toFixed(2)} mV`;
      } else {
        mvcStatusElement.style.display = 'none';
        if (mvcDisplayElement) mvcDisplayElement.textContent = '100.00 mV (Default)';
      }
    }

    function getStatusIndonesian(status) {
      const statusMap = { 'Excellent': 'Sangat Baik', 'Good': 'Baik', 'Fair': 'Cukup', 'Poor': 'Kurang', 'A': 'Sangat Baik', 'B': 'Baik', 'C': 'Cukup', 'D': 'Kurang' };
      return statusMap[status] || 'Kurang';
    }

    function addProfessionalFooter(pdf, pageNumber, totalPages) {
      const pageHeight = pdf.internal.pageSize.height;
      const pageWidth = pdf.internal.pageSize.width;
      pdf.setDrawColor(200, 200, 200);
      pdf.line(15, pageHeight - 20, pageWidth - 15, pageHeight - 20);
      pdf.setFontSize(8);
      pdf.text(`Halaman ${pageNumber} dari ${totalPages}`, pageWidth - 15, pageHeight - 12, null, null, "right");
    }

    function getIconForGrade(grade) {
      switch (grade) {
        case 'A': return 'fas fa-trophy';
        case 'B': return 'fas fa-thumbs-up';
        case 'C': return 'fas fa-exclamation-triangle';
        case 'D': return 'fas fa-times-circle';
        default: return '';
      }
    }

    // Sisa fungsi lain yang tidak relevan dengan perbaikan sesi
    function calculateEMGConsistency(emgFeatures) { return 0; }
    function calculateEMGQuality(rmsValues, mavValues) { return "N/A"; }
    function updateROMStatus(totalRom, consistency) { }
    function updateEMGStatus(rms) { }
    function updateCombinedAnalysisChart() { }
    function updateClassificationChart() { }

    // Initialize charts on page load
    function initializeAllCharts() {
      console.log('[Charts] Initializing all charts on page load...');

      try {
        // Initialize main monitoring charts
        if (document.getElementById('angle-chart') && document.getElementById('emg-chart')) {
          initializeChartsWithCurrentTime();
          console.log('✅ Main charts initialized successfully');
        }

        // Initialize analysis charts if in that tab
        if (document.getElementById('combined-analysis-chart')) {
          // Analysis chart initialization would go here if needed
          console.log('✅ Analysis charts ready');
        }

      } catch (error) {
        console.error('❌ Chart initialization failed:', error);
      }
    }

    // Fungsi Debug
    function testFirebaseRealtimeConnection() {
      console.log('=== TESTING FIREBASE REALTIME CONNECTION ===');
      database.ref('test_connection').set({ timestamp: Date.now() })
        .then(() => console.log('✅ Firebase write test: SUCCESS'))
        .catch(error => console.error('❌ Firebase write test: FAILED', error));
    }
    window.testFirebaseRealtimeConnection = testFirebaseRealtimeConnection;

    // Initialize everything when page loads
    document.addEventListener('DOMContentLoaded', function () {
      console.log('[Init] Page loaded, initializing system...');
      // ✅ ADDED: Initialize MVC calibration listener
      initializeMVCCalibrationListener();

      // Initialize charts immediately
      setTimeout(() => {
        initializeAllCharts();
      }, 500); // Small delay to ensure DOM is fully ready

      // Load data
      loadFilteredData();

      // Set today's date as default
      const today = new Date().toISOString().split('T')[0];
      const dateInput = document.getElementById('new-patient-date');
      if (dateInput) {
        dateInput.value = today;
      }

      console.log('✅ System initialization complete');
    });

    // Fungsi untuk update semua data lama dengan grade baru
    function updateAllGradesWithNewThreshold() {
      if (!confirm('🔄 Update semua data lama dengan threshold EMG 60%?\n\nIni akan memperbarui grade semua data rehabilitasi yang ada.')) {
        return;
      }

      database.ref('rehabilitation').once('value', snapshot => {
        if (!snapshot.exists()) {
          alert('Tidak ada data untuk diupdate.');
          return;
        }

        let updateCount = 0;
        const updates = {};

        snapshot.forEach(child => {
          const data = child.val();
          const key = child.key;

          // Hitung ulang klasifikasi dengan threshold baru
          const emgFeaturesInMVC = {
            rms: data.avgRMSEMG || 0,
            mav: data.avgMAVEMG || 0,
            variance: 0,
            waveformLength: 0,
            zeroCrossings: 0,
            slopeSignChanges: 0
          };

          const romStats = {
            totalROM: data.maxFlexion || data.totalROM || data.avgAngle || 0,
            maxFlexion: data.maxFlexion || 0,
            maxExtension: data.maxExtension || 0,
            consistency: data.romConsistency || 0
          };

          const mvcReference = data.mvcReference || currentMVCReference;

          // Convert raw EMG to %MVC untuk klasifikasi
          const emgPercentMVC = convertEMGToPercentage(data.avgRMSEMG || 0, mvcReference);
          emgFeaturesInMVC.rms = emgPercentMVC;

          const newClassification = classifyRehabilitationPerformanceMVC(
            emgFeaturesInMVC,
            romStats,
            mvcReference
          );

          // Update hanya jika grade berubah
          if (data.grade !== newClassification.grade) {
            updates[`rehabilitation/${key}/grade`] = newClassification.grade;
            updates[`rehabilitation/${key}/status`] = newClassification.status;
            updates[`rehabilitation/${key}/combinedScore`] = newClassification.combinedScore;
            updates[`rehabilitation/${key}/updatedAt`] = new Date().toISOString();
            updates[`rehabilitation/${key}/gradeUpdateReason`] = 'EMG threshold changed to 60%';
            updateCount++;
          }
        });

        if (updateCount === 0) {
          alert('✅ Tidak ada data yang perlu diupdate.');
          return;
        }

        // Batch update ke Firebase
        database.ref().update(updates).then(() => {
          alert(`✅ Berhasil update ${updateCount} data dengan threshold EMG baru (60%)!`);

          // Refresh tampilan data
          if (selectedPatient) {
            loadFilteredData();
          } else {
            loadAllData();
          }
        }).catch(error => {
          console.error('Error updating grades:', error);
          alert('❌ Gagal update data: ' + error.message);
        });
      });
    }

    // Tambahkan tombol untuk manual update (opsional)
    // Bisa dipanggil melalui console: updateAllGradesWithNewThreshold()

  </script>

  <div id="debug-info"
    style="position: fixed; top: 10px; right: 10px; background: rgba(0,0,0,0.8); color: white; padding: 10px; border-radius: 5px; font-family: monospace; font-size: 12px; z-index: 9999; display: none;">
    <div>Sesi Aktif: <span id="debug-session-active">TIDAK</span></div>
    <div>Dijeda: <span id="debug-session-paused">YA</span></div>
    <div>Firebase: <span id="debug-firebase-status">DISCONNECTED</span></div>
    <div>Data Terakhir: <span id="debug-last-data">NONE</span></div>
    <div>Pasien: <span id="debug-patient-name">NONE</span></div>
  </div>

  <script>
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'd') {
        e.preventDefault();
        const debugInfo = document.getElementById('debug-info');
        debugInfo.style.display = debugInfo.style.display === 'none' ? 'block' : 'none';
      }
    });

    setInterval(() => {
      document.getElementById('debug-session-active').textContent = isSessionActive ? 'YA' : 'TIDAK';
      document.getElementById('debug-session-paused').textContent = isPaused ? 'YA' : 'TIDAK';
      document.getElementById('debug-firebase-status').textContent = firebaseConnected ? 'CONNECTED' : 'DISCONNECTED';
      document.getElementById('debug-last-data').textContent = lastDataTimestamp ? new Date(lastDataTimestamp).toLocaleTimeString() : 'NONE';
      document.getElementById('debug-patient-name').textContent = selectedPatient ? selectedPatient.name : 'NONE';
    }, 1000);

    // ======================== EMG CALIBRATION FUNCTIONS ========================

    // ======================== EMG CALIBRATION FUNCTIONS ========================

    let calibrationInProgress = false;      // Flag: proses calibration sedang berjalan
    let calibrationListener = null;         // Listener untuk response ESP32

    // GANTI SELURUH FUNGSI LAMA ANDA DENGAN VERSI YANG SUDAH DIPERBAIKI INI
    function startEMGCalibration() {
      if (!selectedPatient) {
        alert('Pilih pasien terlebih dahulu!');
        return;
      }

      if (isSessionActive) {
        alert('Tidak dapat memulai kalibrasi saat sesi sedang berjalan!\n\nSilakan jeda atau akhiri sesi terlebih dahulu.');
        return;
      }

      if (!confirm(`Mulai kalibrasi MVC untuk ${selectedPatient.name}?\n\nPastikan:\n✓ Elektroda terpasang dengan baik\n✓ Pasien siap untuk kontraksi maksimal`)) {
        return;
      }

      console.log('[MVC] Starting calibration process...');
      calibrationInProgress = true;

      // Update UI
      const statusEl = document.getElementById('calibration-status');
      const startBtn = document.getElementById('start-calibration-btn');
      const stopBtn = document.getElementById('stop-calibration-btn');
      const instructionsEl = document.getElementById('calibration-instructions');

      if (statusEl) {
        statusEl.textContent = 'Menyiapkan...';
        statusEl.className = 'px-2 py-1 rounded-full text-xs font-bold bg-blue-700 text-blue-300';
      }
      if (startBtn) startBtn.style.display = 'none';
      if (stopBtn) stopBtn.style.display = 'inline-block';
      if (instructionsEl) instructionsEl.style.display = 'block';

      // --- BAGIAN BARU: BERSIHKAN DATA LAMA TERLEBIH DAHULU ---
      // Ini akan menghapus "surat lama" dari "kotak surat"
      database.ref('mvc_calibration_data').set({
        calibrating: false,
        completed: false,
        progress: 0,
        timestamp: Date.now()
      }).then(() => {
        console.log('[MVC] Old calibration data cleared.');

        // SETELAH BERHASIL DIBERSIHKAN, BARU LANJUTKAN

        // 1. Mulai mendengarkan data BARU
        setupCalibrationListener();

        // 2. Kirim perintah START ke ESP32
        database.ref('session_control').set({
          command: 'START_MVC_CALIBRATION',
          timestamp: Date.now(),
          patientId: selectedPatient.name.replace(/\s+/g, '_'),
          patientName: selectedPatient.name
        }).then(() => {
          console.log('[WEB] START_MVC_CALIBRATION command sent to ESP32');
        }).catch(error => {
          console.error('[WEB] Failed to send command:', error);
          alert('Gagal mengirim perintah ke ESP32!');
          stopEMGCalibration(); // Batalkan jika gagal
        });

      }).catch(error => {
        console.error('[MVC] Failed to clear old data:', error);
        alert('Gagal mereset status kalibrasi di server!');
        stopEMGCalibration(); // Batalkan jika gagal
      });
      // --- AKHIR BAGIAN BARU ---
    }

    function stopEMGCalibration() {
      if (!calibrationInProgress) return;

      console.log('[MVC] Stopping calibration...');

      calibrationInProgress = false;

      if (calibrationListener) {
        database.ref('mvc_calibration_data').off('value', calibrationListener);
        calibrationListener = null;
      }

      database.ref('session_control').set({
        command: 'STOP_MVC_CALIBRATION',
        timestamp: Date.now(),
        patientId: selectedPatient.name
      });

      const statusEl = document.getElementById('calibration-status');
      const startBtn = document.getElementById('start-calibration-btn');
      const stopBtn = document.getElementById('stop-calibration-btn');
      const progressEl = document.getElementById('calibration-progress');
      const timerEl = document.getElementById('calibration-timer');
      const instructionsEl = document.getElementById('calibration-instructions');

      if (statusEl) {
        statusEl.textContent = 'Siap';
        statusEl.className = 'px-2 py-1 rounded-full text-xs font-bold bg-slate-700 text-slate-300';
      }
      if (startBtn) startBtn.style.display = 'inline-block';
      if (stopBtn) stopBtn.style.display = 'none';
      if (progressEl) progressEl.style.display = 'none';
      if (timerEl) timerEl.style.display = 'none';
      if (instructionsEl) instructionsEl.style.display = 'none';

      console.log('[MVC] Calibration stopped');
    }

    // ======================== BARU: CALIBRATION LISTENER ========================

    // GANTI SELURUH FUNGSI LAMA DENGAN YANG INI
    function setupCalibrationListener() {
      if (calibrationListener) {
        database.ref('mvc_calibration_data').off('value', calibrationListener);
      }

      console.log('[MVC] Setting up calibration data listener...');
      const progressEl = document.getElementById('calibration-progress');
      const progressBar = document.getElementById('calibration-progress-bar');
      const timerEl = document.getElementById('calibration-timer');
      const statusEl = document.getElementById('calibration-status');

      calibrationListener = database.ref('mvc_calibration_data').on('value', (snapshot) => {
        const data = snapshot.val();
        // Hanya proses jika ada data DAN proses kalibrasi memang sedang berjalan (di-trigger dari web)
        if (!data || !calibrationInProgress) return;

        // --- BAGIAN BARU: MENANGANI DATA PROGRESS REAL-TIME ---
        if (data.calibrating === true && data.completed === false) {
          if (statusEl) {
            statusEl.textContent = 'Kontraksi!';
            statusEl.className = 'px-2 py-1 rounded-full text-xs font-bold bg-orange-700 text-orange-300 animate-pulse';
          }
          if (progressEl) progressEl.style.display = 'flex';
          if (timerEl) timerEl.style.display = 'inline';

          const progress = data.progress || 0;
          if (progressBar) progressBar.style.width = `${progress}%`;

          const timeLeft = 5 - (5 * progress / 100);
          if (timerEl) timerEl.textContent = `${timeLeft.toFixed(1)}s`;

          if (data.rmsEMG) {
            updateRMSEMG(data.rmsEMG); // Update nilai RMS di UI
          }
        }
        // --- AKHIR BAGIAN BARU ---

        // Menangani data hasil akhir (logika ini sudah ada)
        if (data.completed === true) {
          handleCalibrationComplete(data);
        }
      }, (error) => {
        console.error('[MVC] Listener error:', error);
      });
    }

    function handleCalibrationComplete(data) {
      if (!calibrationInProgress) return;

      console.log('[MVC] Calibration completed:', data);

      if (calibrationListener) {
        database.ref('mvc_calibration_data').off('value', calibrationListener);
        calibrationListener = null;
      }

      calibrationInProgress = false;

      // Update UI
      const statusEl = document.getElementById('calibration-status');
      const startBtn = document.getElementById('start-calibration-btn');
      const stopBtn = document.getElementById('stop-calibration-btn');
      const instructionsEl = document.getElementById('calibration-instructions');

      if (stopBtn) stopBtn.style.display = 'none';
      if (startBtn) startBtn.style.display = 'inline-block';
      if (instructionsEl) instructionsEl.style.display = 'none';

      if (data.success && data.finalMVC && data.finalMVC > 0) {
        console.log('[MVC] Calibration SUCCESS:', data.finalMVC, 'mV');

        currentMVCReference = data.finalMVC;
        updateMVCReference(data.finalMVC);

        if (statusEl) {
          statusEl.textContent = 'Selesai';
          statusEl.className = 'px-2 py-1 rounded-full text-xs font-bold bg-green-700 text-green-300';
        }

        alert(`✓ KALIBRASI BERHASIL!\n\nNilai MVC: ${data.finalMVC.toFixed(2)} mV\nSample Valid: ${data.validSamples || 0}\n\nData telah disimpan untuk ${selectedPatient.name}`);

        setTimeout(() => {
          if (statusEl) {
            statusEl.textContent = 'Siap';
            statusEl.className = 'px-2 py-1 rounded-full text-xs font-bold bg-slate-700 text-slate-300';
          }
        }, 2000);

      } else {
        const errorMsg = data.errorMessage || 'Sinyal EMG terlalu lemah atau tidak stabil';
        console.log('[MVC] Calibration FAILED:', errorMsg);

        if (statusEl) {
          statusEl.textContent = 'Gagal';
          statusEl.className = 'px-2 py-1 rounded-full text-xs font-bold bg-red-700 text-red-300';
        }

        alert(`✗ KALIBRASI GAGAL!\n\n${errorMsg}\n\nTips:\n✓ Pastikan elektroda terpasang dengan baik\n✓ Lakukan kontraksi otot maksimal\n✓ Coba lagi dengan kontraksi lebih kuat`);

        setTimeout(() => {
          if (statusEl) {
            statusEl.textContent = 'Siap';
            statusEl.className = 'px-2 py-1 rounded-full text-xs font-bold bg-slate-700 text-slate-300';
          }
        }, 2000);
      }
    }

    function updateMVCReference(value) {
      mvcReference = value;
      currentMVCReference = value;

      // Update all MVC reference displays
      const mvcRefElement = document.getElementById('mvc-reference-value');
      if (mvcRefElement) {
        mvcRefElement.textContent = value.toFixed(1) + ' mV';
      }

      const displayMvcRefElement = document.getElementById('display-mvc-reference');
      if (displayMvcRefElement) {
        displayMvcRefElement.textContent = value.toFixed(2) + ' mV';
      }

      console.log('[Calibration] MVC Reference updated to:', value);
    }

    function updateMVCPercentage(percentage) {
      currentMVCPercentage = percentage;
      document.getElementById('current-mvc-percentage').textContent = percentage.toFixed(1) + '%';
    }

    function updateRMSEMG(rms) {
      document.getElementById('current-rms-emg').textContent = rms.toFixed(1) + ' mV';
    }

    // Listen for MVC calibration data from ESP32
    // ======================== FIXED MVC CALIBRATION LISTENER ========================
    let mvcCalibrationListener = null;
    let calibrationCheckInterval = null;

    function initializeMVCCalibrationListener() {
      // Remove old listener if exists
      if (mvcCalibrationListener) {
        database.ref('mvc_calibration_data').off('value', mvcCalibrationListener);
      }

      console.log('[MVC] 🎧 Starting calibration listener...');

      mvcCalibrationListener = database.ref('mvc_calibration_data').on('value', (snapshot) => {
        const data = snapshot.val();

        if (!data) {
          console.log('[MVC] ⚠️ No calibration data available');
          return;
        }

        console.log('[MVC] 📡 Received data:', data);

        // Update real-time progress during calibration
        if (data.calibrating && isCalibrating) {
          console.log('[MVC] 📊 Calibration in progress...');

          if (data.rmsEMG) {
            updateRMSEMG(data.rmsEMG);
            console.log('[MVC] Current RMS:', data.rmsEMG);
          }

          if (data.progress !== undefined) {
            const progressBar = document.getElementById('calibration-progress-bar');
            if (progressBar) {
              progressBar.style.width = Math.min(data.progress, 100) + '%';
            }
          }
        }

        // ✅ HANDLE CALIBRATION COMPLETION
        if (data.completed && isCalibrating) {
          console.log('[MVC] ✅ Calibration completed!', {
            success: data.success,
            finalMVC: data.finalMVC
          });

          // Stop checking interval
          if (calibrationCheckInterval) {
            clearInterval(calibrationCheckInterval);
            calibrationCheckInterval = null;
          }

          if (data.success && data.finalMVC && data.finalMVC > 0) {
            // SUCCESS CASE
            console.log('[MVC] 🎉 Calibration SUCCESS:', data.finalMVC, 'mV');

            // Update global MVC reference
            currentMVCReference = data.finalMVC;
            updateMVCReference(data.finalMVC);

            // Save to patient-specific calibration data
            if (selectedPatient) {
              const patientKey = selectedPatient.name.replace(/\s+/g, '_');
              const mvcData = {
                maxMVC: data.finalMVC,
                calibrationDate: new Date().toISOString(),
                peakRMS: data.peakRMS || data.finalMVC,
                validSamples: data.validSamples || 150,
                patientName: selectedPatient.name
              };

              database.ref(`mvc_calibration/${patientKey}`).set(mvcData).then(() => {
                console.log('[MVC] 💾 Saved to patient calibration data');
              }).catch(error => {
                console.error('[MVC] ❌ Failed to save:', error);
              });
            }

            // Stop calibration UI
            stopEMGCalibration();

            // Show success notification
            alert(`✅ KALIBRASI MVC BERHASIL!\n\n🎯 Nilai MVC Baru: ${data.finalMVC.toFixed(2)} mV\n\n✓ Data telah disimpan untuk ${selectedPatient ? selectedPatient.name : 'pasien ini'}`);

          } else {
            // FAILURE CASE
            console.log('[MVC] ❌ Calibration FAILED:', data.errorMessage || 'Unknown error');

            stopEMGCalibration();

            const errorMsg = data.errorMessage || 'Sinyal EMG terlalu lemah atau tidak stabil';
            alert(`❌ KALIBRASI MVC GAGAL!\n\n${errorMsg}\n\nTips:\n✓ Pastikan elektroda terpasang dengan baik\n✓ Lakukan kontraksi otot maksimal\n✓ Coba lagi dengan kontraksi lebih kuat`);
          }
        }
      }, (error) => {
        console.error('[MVC] ❌ Listener error:', error);
      });

      console.log('[MVC] ✅ Calibration listener initialized');
    }

    // Initialize listener when page loads
    document.addEventListener('DOMContentLoaded', function () {
      console.log('[MVC] Initializing on page load...');
      initializeMVCCalibrationListener();
    });

    // ======================== PAGINATION FUNCTIONS ========================

    let logCurrentPage = 1;
    let logItemsPerPage = 10;
    let logTotalItems = 0;
    let logAllData = [];

    let rehabCurrentPage = 1;
    let rehabItemsPerPage = 10;
    let rehabTotalItems = 0;
    let rehabAllData = [];

    function changeLogPage(direction) {
      const newPage = logCurrentPage + direction;
      const totalPages = Math.ceil(logTotalItems / logItemsPerPage);

      if (newPage >= 1 && newPage <= totalPages) {
        logCurrentPage = newPage;
        displayLogPage();
      }
    }

    function changeRehabPage(direction) {
      const newPage = rehabCurrentPage + direction;
      const totalPages = Math.ceil(rehabTotalItems / rehabItemsPerPage);

      if (newPage >= 1 && newPage <= totalPages) {
        rehabCurrentPage = newPage;
        displayRehabPage();
      }
    }
    // Fungsi bantu: Konversi point ke grade
    function getGradeFromPoints(points) {
      if (points >= 1.5) return { grade: "A", icon: "🏆" };
      if (points >= 1.0) return { grade: "B", icon: "👍" };
      if (points >= 0.5) return { grade: "C", icon: "🙂" };
      return { grade: "D", icon: "⚠️" };
    }

    // ------------------- LOG TABLE -------------------
    async function displayLogPage() {
      const startIndex = (logCurrentPage - 1) * logItemsPerPage;
      const endIndex = Math.min(startIndex + logItemsPerPage, logTotalItems);
      const pageData = logAllData.slice(startIndex, endIndex);

      const logTable = document.getElementById('log-aktivitas-table');
      logTable.innerHTML = '';

      pageData.sort((a, b) => {
        const dateDiff = new Date(b.date || 0) - new Date(a.date || 0);
        if (dateDiff !== 0) return dateDiff;
        return (Number(b.rehabSession) || 0) - (Number(a.rehabSession) || 0);
      });

      for (const data of pageData) {
        const duration = data.sessionDuration ? formatDuration(data.sessionDuration) : '-';
        const mvcReference = await getPatientMVCReference(data.name) || currentMVCReference;

        // --- Hitung %MVC ---
        const percentMVC = convertEMGToPercentage(data.avgRMSEMG || 0, mvcReference);
        const percentMVCDisplay = formatEMGDisplay(percentMVC, 'percentage');
        const rmsDisplay = formatEMGDisplay(data.avgRMSEMG || 0, 'raw');

        // --- Ambil ROM tertinggi ---
        let romValueRaw = data.totalROM || data.avgAngle || 0;
        if (data.maxFlexion) {
          romValueRaw = Math.max(parseFloat(romValueRaw), parseFloat(data.maxFlexion));
        }

        let romValue = 0;
        if (typeof romValueRaw === "string" && romValueRaw.includes("-")) {
          const parts = romValueRaw.split("-").map(x => parseFloat(x.trim()));
          romValue = Math.max(...parts);
        } else {
          romValue = parseFloat(romValueRaw) || 0;
        }

        // --- Hitung point ROM & EMG ---
        const romPoints = romValue >= 120 ? 1.5 : (romValue >= 90 ? 1.0 : (romValue >= 60 ? 0.5 : 0));
        const emgPoints = percentMVC >= 60 ? 1.5 : (percentMVC >= 40 ? 1.0 : (percentMVC >= 20 ? 0.5 : 0));

        // --- Grade ROM & RMS ---
        const romGrade = getGradeFromPoints(romPoints);
        const rmsGrade = getGradeFromPoints(emgPoints);

        // --- Masukkan ke tabel ---
        // Render baris tabel
        const row = logTable.insertRow();
        row.innerHTML = `
    <td class="col-nama" style="text-align: left; font-weight: 500;">${data.name}</td>
    <td class="col-gender" style="text-align: center;">${data.gender || 'Tidak Diketahui'}</td>
    <td class="col-tanggal" style="text-align: center;">${new Date(data.date).toLocaleDateString('id-ID')}</td>
    <td style="text-align: center; font-weight: 600; color: #3b82f6;">${data.rehabSession}</td>
    <td style="text-align: center; font-weight: 600; color: #8b5cf6;">${duration}</td>
    <td style="text-align: center; font-weight: 600; color: #10b981;">
        ${(data.maxExtension || 0).toFixed(1)} - ${(data.maxFlexion || data.totalROM || data.avgAngle || 0).toFixed(1)}°
    </td>
    <td style="text-align: center; font-weight: 600; color: #22c55e;">
        ${data.maxFlexion ? data.maxFlexion.toFixed(1) + '°' : '0.0'}
    </td>
    <td style="text-align: center; font-weight: 600; color: #3b82f6;">
        ${data.maxExtension ? Math.abs(data.maxExtension).toFixed(1) + '°' : '0.0'}
    </td>
    <td style="text-align: center; font-weight: 600; color: #10b981;">${rmsDisplay}</td>
    <td style="text-align: center; font-weight: 600; color: #ef4444;">${percentMVCDisplay}</td>
    <td style="text-align: center; font-weight: 600; color: #f59e0b;">${(data.mvcReference || currentMVCReference || EMG_CONSTANTS.DEFAULT_MVC_REFERENCE).toFixed(1)} mV</td>
    <td style="text-align: center; font-weight: 600;">${romGrade.grade} ${romGrade.icon}</td>
    <td style="text-align: center; font-weight: 600;">${rmsGrade.grade} ${rmsGrade.icon}</td>
    <td style="text-align: center;">
        <button onclick="editRehabData('${data.firebaseKey}', '${data.name.replace(/'/g, "\\'")}', '${data.rehabSession}', '${data.date}', '${data.avgAngle || 0}', ${percentMVC.toFixed(1)}, '${data.avgMAVEMG || 0}', '${data.sessionDuration || 0}')" class="btn-warning mr-2" style="padding: 4px 8px; font-size: 12px;">
            <i class="fas fa-edit"></i>
        </button>
        <button onclick="deleteRehabData('${data.firebaseKey}', '${data.name}', ${data.rehabSession})" class="btn-danger" style="padding: 4px 8px; font-size: 12px;">
            <i class="fas fa-trash"></i>
        </button>
    </td>
`;


      }

      document.getElementById('log-start-item').textContent = startIndex + 1;
      document.getElementById('log-end-item').textContent = endIndex;
      document.getElementById('log-total-items').textContent = logTotalItems;
      document.getElementById('log-page-info').textContent = `Halaman ${logCurrentPage}`;
      document.getElementById('log-prev-btn').disabled = logCurrentPage <= 1;
      document.getElementById('log-next-btn').disabled = logCurrentPage >= Math.ceil(logTotalItems / logItemsPerPage);
    }

    // ------------------- REHAB TABLE -------------------
    function displayRehabPage() {
      const startIndex = (rehabCurrentPage - 1) * rehabItemsPerPage;
      const endIndex = Math.min(startIndex + rehabItemsPerPage, rehabTotalItems);
      const pageData = rehabAllData.slice(startIndex, endIndex);

      const rehabTable = document.getElementById('rehab-data-table');
      rehabTable.innerHTML = '';

      // Urutkan terbaru
      pageData.sort((a, b) => {
        const dateDiff = new Date(b.date || 0) - new Date(a.date || 0);
        if (dateDiff !== 0) return dateDiff;
        return (Number(b.rehabSession) || 0) - (Number(a.rehabSession) || 0);
      });

      for (const data of pageData) {
        const duration = data.sessionDuration ? formatDuration(data.sessionDuration) : '-';
        const mvcReference = getSafeMVCReference(data.mvcReference || currentMVCReference);

        // Hitung %MVC & tampilkan EMG
        const percentMVC = convertEMGToPercentage(data.avgRMSEMG || 0, mvcReference);
        const rmsDisplay = formatEMGDisplay(data.avgRMSEMG || 0, 'raw');
        const percentMVCDisplay = formatEMGDisplay(percentMVC, 'percentage');

        // Ambil ROM tertinggi
        let romValueRaw = data.totalROM || data.avgAngle || 0;
        if (data.maxFlexion) {
          romValueRaw = Math.max(parseFloat(romValueRaw), parseFloat(data.maxFlexion));
        }
        let romValue = 0;
        if (typeof romValueRaw === "string" && romValueRaw.includes("-")) {
          const parts = romValueRaw.split("-").map(x => parseFloat(x.trim()));
          romValue = Math.max(...parts);
        } else {
          romValue = parseFloat(romValueRaw) || 0;
        }

        // Hitung point ROM & EMG
        const romPoints = romValue >= 120 ? 1.5 : (romValue >= 90 ? 1.0 : (romValue >= 60 ? 0.5 : 0));
        const emgPoints = percentMVC >= 60 ? 1.5 : (percentMVC >= 40 ? 1.0 : (percentMVC >= 20 ? 0.5 : 0));

        // Grade ROM & RMS
        const romGrade = getGradeFromPoints(romPoints);
        const rmsGrade = getGradeFromPoints(emgPoints);

        // Masukkan ke tabel
        const row = rehabTable.insertRow();
        row.innerHTML = `
    <td class="col-nama" style="text-align: left; font-weight: 500;">${data.name}</td>
   <td class="col-tanggal" style="text-align: center;">${new Date(data.date).toLocaleDateString('id-ID')}</td>
    <td style="text-align: center; font-weight: 600; color: #3b82f6;">${data.rehabSession}</td>
    <td style="text-align: center; font-weight: 600; color: #8b5cf6;">${duration}</td>
    <td style="text-align: center; font-weight: 600; color: #10b981;">
        ${(data.maxExtension || 0).toFixed(1)} - ${(data.maxFlexion || data.totalROM || data.avgAngle || 0).toFixed(1)}°
    </td>
    <td style="text-align: center; font-weight: 600; color: #22c55e;">
        ${data.maxFlexion ? data.maxFlexion.toFixed(1) + '°' : '0.0'}
    </td>
    <td style="text-align: center; font-weight: 600; color: #3b82f6;">
        ${data.maxExtension ? Math.abs(data.maxExtension).toFixed(1) + '°' : '0.0'}
    </td>
    <td style="text-align: center; font-weight: 600; color: #10b981;">${rmsDisplay}</td>
    <td style="text-align: center; font-weight: 600; color: #ef4444;">${percentMVCDisplay}</td>
    <td style="text-align: center; font-weight: 600; color: #f59e0b;">${(data.mvcReference || currentMVCReference || EMG_CONSTANTS.DEFAULT_MVC_REFERENCE).toFixed(1)} mV</td>
    <td style="text-align: center; font-weight: 600;">${romGrade.grade} ${romGrade.icon}</td>
    <td style="text-align: center; font-weight: 600;">${rmsGrade.grade} ${rmsGrade.icon}</td>
`;

      }

      // Update info halaman
      document.getElementById('rehab-start-item').textContent = startIndex + 1;
      document.getElementById('rehab-end-item').textContent = endIndex;
      document.getElementById('rehab-total-items').textContent = rehabTotalItems;
      document.getElementById('rehab-page-info').textContent = `Halaman ${rehabCurrentPage}`;
      document.getElementById('rehab-prev-btn').disabled = rehabCurrentPage <= 1;
      document.getElementById('rehab-next-btn').disabled = rehabCurrentPage >= Math.ceil(rehabTotalItems / rehabItemsPerPage);
    }




  </script>
  <script>
    function updateAverageRMS() {
      const source = document.getElementById("display-rms");
      const target = document.getElementById("average-rms-emg");

      if (source && target) {
        const value = source.textContent.trim();
        if (value !== target.textContent.trim()) {
          target.textContent = value;
        }
      }
    }

    // Jalankan pertama kali
    updateAverageRMS();

    // --- 1. Gunakan MutationObserver (utama) ---
    const sourceNode = document.getElementById("display-rms");
    if (sourceNode) {
      const observer = new MutationObserver(updateAverageRMS);
      observer.observe(sourceNode, {
        childList: true,
        characterData: true,
        subtree: true
      });
    }

    // --- 2. Tambahkan fallback pakai setInterval (backup) ---
    setInterval(updateAverageRMS, 1000);
