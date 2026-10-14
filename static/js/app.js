/**
 * CardioViz AI - Main Application Controller
 * ============================================
 * Orchestrates the patient input form, API communication,
 * 3D heart visualization, SHAP charts, and dashboard updates.
 */

import { Heart3D } from './heart3d.js?v=clinical-20261015';
import { loadPredictorModels, predictPatient } from './predictor.js';

// ─── Configuration ────────────────────────────────────────────────────────────

let metadata = null;
let heart3d = null;
let predictorModels = null;
let currentPrediction = null;
let currentSampleIndex = 0;

// ─── Initialization ───────────────────────────────────────────────────────────

async function init() {
    updateLoadingStatus('Loading metadata...');

    try {
        // Keep the app self-contained for static hosts such as Netlify.
        const response = await fetch(new URL('../ml/metadata.json', import.meta.url));
        if (!response.ok) throw new Error('Failed to load metadata');
        metadata = await response.json();

        updateLoadingStatus('Loading prediction models...');
        predictorModels = await loadPredictorModels();

        updateLoadingStatus('Building patient form...');
        buildPatientForm();

        updateLoadingStatus('Initializing 3D visualization...');
        initHeart3D();

        updateLoadingStatus('Loading model metrics...');
        displayModelMetrics();

        // Setup event listeners
        setupEventListeners();

        // Update model status badge
        const badge = document.getElementById('model-status');
        badge.innerHTML = `<span class="badge-dot ready"></span><span>${metadata.target_names.length} Models Ready</span>`;

        // Hide loading overlay
        setTimeout(() => {
            document.getElementById('loading-overlay').classList.add('hidden');
        }, 800);

    } catch (error) {
        console.error('Initialization error:', error);
        updateLoadingStatus(`Error: ${error.message}. Make sure the server is running.`);
    }
}

function updateLoadingStatus(text) {
    const el = document.getElementById('loading-status');
    if (el) el.textContent = text;
}

// ─── Patient Input Form ──────────────────────────────────────────────────────

function buildPatientForm() {
    const container = document.getElementById('patient-form-container');
    if (!metadata || !metadata.feature_stats) return;

    container.innerHTML = '';

    // Group features by category
    const categories = {};
    for (const [featName, stats] of Object.entries(metadata.feature_stats)) {
        const cat = stats.category || 'Other';
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push({ name: featName, ...stats });
    }

    // Render each category
    const categoryOrder = ['Demographics', 'Medical History', 'Vital Signs', 'Symptoms', 'ECG', 'Laboratory', 'Echocardiography', 'Other'];
    const catIcons = {
        'Demographics': '01',
        'Medical History': '02',
        'Vital Signs': '03',
        'Symptoms': '04',
        'ECG': '05',
        'Laboratory': '06',
        'Echocardiography': '07',
        'Other': '08'
    };

    for (const catName of categoryOrder) {
        const features = categories[catName];
        if (!features || features.length === 0) continue;

        const catDiv = document.createElement('div');
        catDiv.className = 'form-category';
        catDiv.innerHTML = `
            <div class="form-category-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="form-category-title"><span class="category-index">${catIcons[catName] || '00'}</span> ${catName} (${features.length})</span>
                <span class="form-category-toggle">▼</span>
            </div>
            <div class="form-category-fields"></div>
        `;

        const fieldsContainer = catDiv.querySelector('.form-category-fields');

        for (const feat of features) {
            const fieldDiv = document.createElement('div');
            fieldDiv.className = 'form-field';

            if (feat.is_binary) {
                // Binary toggle
                fieldDiv.innerHTML = `
                    <label title="${feat.name}">${feat.name}</label>
                    <div class="toggle-container" data-feature="${feat.name}" data-value="0" onclick="toggleBinary(this)">
                        <span class="toggle-label">No</span>
                        <div class="toggle-switch"></div>
                    </div>
                `;
            } else if (feat.is_categorical && feat.labels) {
                // Dropdown for categorical
                const options = Object.entries(feat.labels)
                    .map(([label, val]) => `<option value="${val}">${label}</option>`)
                    .join('');
                fieldDiv.innerHTML = `
                    <label title="${feat.name}">${feat.name}</label>
                    <select data-feature="${feat.name}">${options}</select>
                `;
            } else {
                // Numeric input
                fieldDiv.innerHTML = `
                    <label title="${feat.name} (${feat.min.toFixed(1)} - ${feat.max.toFixed(1)})">${feat.name}</label>
                    <input type="number" 
                           data-feature="${feat.name}" 
                           placeholder="${feat.mean}" 
                           step="any"
                           min="${feat.min}"
                           max="${feat.max}"
                           title="Range: ${feat.min.toFixed(1)} - ${feat.max.toFixed(1)}, Mean: ${feat.mean}">
                `;
            }

            fieldsContainer.appendChild(fieldDiv);
        }

        container.appendChild(catDiv);
    }

    // Collapse all except Demographics by default
    const cats = container.querySelectorAll('.form-category');
    cats.forEach((cat, idx) => {
        if (idx > 0) cat.classList.add('collapsed');
    });
}

// Toggle binary fields
window.toggleBinary = function(el) {
    const current = el.dataset.value;
    const newVal = current === '0' ? '1' : '0';
    el.dataset.value = newVal;
    el.querySelector('.toggle-label').textContent = newVal === '1' ? 'Yes' : 'No';
    el.classList.toggle('active', newVal === '1');
};

// ─── Collect Form Data ───────────────────────────────────────────────────────

function collectFormData() {
    const data = {};

    // Numeric inputs
    document.querySelectorAll('#patient-form-container input[data-feature]').forEach(el => {
        const feat = el.dataset.feature;
        const val = el.value.trim();
        if (val !== '') {
            data[feat] = parseFloat(val);
        }
    });

    // Select inputs
    document.querySelectorAll('#patient-form-container select[data-feature]').forEach(el => {
        data[el.dataset.feature] = parseFloat(el.value);
    });

    // Toggle inputs
    document.querySelectorAll('#patient-form-container .toggle-container[data-feature]').forEach(el => {
        data[el.dataset.feature] = parseFloat(el.dataset.value);
    });

    return data;
}

function fillFormData(patient) {
    for (const [feat, value] of Object.entries(patient)) {
        if (feat.startsWith('_')) continue;

        // Numeric inputs
        const numInput = document.querySelector(`input[data-feature="${feat}"]`);
        if (numInput) {
            numInput.value = typeof value === 'number' ? parseFloat(value.toFixed(4)) : value;
            continue;
        }

        // Select inputs
        const selInput = document.querySelector(`select[data-feature="${feat}"]`);
        if (selInput) {
            selInput.value = value;
            continue;
        }

        // Toggle inputs
        const toggleInput = document.querySelector(`.toggle-container[data-feature="${feat}"]`);
        if (toggleInput) {
            const strVal = String(Math.round(value));
            toggleInput.dataset.value = strVal;
            toggleInput.querySelector('.toggle-label').textContent = strVal === '1' ? 'Yes' : 'No';
            toggleInput.classList.toggle('active', strVal === '1');
        }
    }
}

function clearForm() {
    document.querySelectorAll('#patient-form-container input[data-feature]').forEach(el => {
        el.value = '';
    });
    document.querySelectorAll('#patient-form-container select[data-feature]').forEach(el => {
        el.selectedIndex = 0;
    });
    document.querySelectorAll('#patient-form-container .toggle-container[data-feature]').forEach(el => {
        el.dataset.value = '0';
        el.querySelector('.toggle-label').textContent = 'No';
        el.classList.remove('active');
    });
}

// ─── 3D Heart Initialization ─────────────────────────────────────────────────

function initHeart3D() {
    const container = document.getElementById('three-canvas-container');
    if (!container) return;

    heart3d = new Heart3D(container);

    // Listen for artery selection events
    window.addEventListener('artery-selected', (e) => {
        const key = e.detail.arteryKey;
        // Highlight vessel card in the dashboard
        document.querySelectorAll('.vessel-card').forEach(card => {
            card.classList.remove('active');
        });
        const vesselCard = document.getElementById(`vessel-${key.toLowerCase()}`);
        if (vesselCard) vesselCard.classList.add('active');

        // Switch SHAP display to selected artery
        const shapSelect = document.getElementById('shap-target-select');
        if (shapSelect) {
            shapSelect.value = key;
            if (currentPrediction) {
                displaySHAPChart(key);
            }
        }
    });

    window.addEventListener('artery-deselected', () => {
        document.querySelectorAll('.vessel-card').forEach(card => {
            card.classList.remove('active');
        });
    });
}

// ─── API Prediction ──────────────────────────────────────────────────────────

async function runPrediction() {
    const btn = document.getElementById('btn-predict');
    btn.disabled = true;
    btn.innerHTML = `
        <svg class="spin" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
        </svg>
        Analyzing...
    `;

    try {
        const data = collectFormData();
        currentPrediction = predictPatient(data, metadata, predictorModels);
        updateDashboard(currentPrediction);
        update3DVisualization(currentPrediction);

    } catch (error) {
        console.error('Prediction error:', error);
        alert(`Prediction error: ${error.message}`);
    } finally {
        btn.disabled = false;
        btn.innerHTML = `
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
            Analyze Risk
        `;
    }
}

// ─── Dashboard Updates ───────────────────────────────────────────────────────

function updateDashboard(result) {
    const predictions = result.predictions;

    // CAD status
    if (predictions.Cath) {
        updateVesselCard('cath', predictions.Cath);
        updateRiskGauge(predictions.Cath.probability, predictions.Cath.risk_level);
    } else {
        updateRiskGauge(result.overall_risk, result.overall_risk_level);
    }

    // Vessel-specific results
    if (predictions.LAD) updateVesselCard('lad', predictions.LAD);
    if (predictions.LCX) updateVesselCard('lcx', predictions.LCX);
    if (predictions.RCA) updateVesselCard('rca', predictions.RCA);

    // SHAP chart
    const shapTarget = document.getElementById('shap-target-select').value;
    displaySHAPChart(shapTarget);
}

function updateRiskGauge(probability, level) {
    const maxDash = 251.2;
    const fillDash = probability * maxDash;

    const gaugeFill = document.getElementById('gauge-fill');
    const gaugeText = document.getElementById('gauge-text');
    const badge = document.getElementById('overall-risk-badge');

    // Animate gauge fill
    gaugeFill.style.transition = 'stroke-dasharray 1s ease-out';
    gaugeFill.setAttribute('stroke-dasharray', `${fillDash} ${maxDash}`);

    // Update text
    gaugeText.textContent = `${(probability * 100).toFixed(1)}%`;

    // Update badge
    badge.textContent = level.toUpperCase();
    badge.className = `risk-badge ${level}`;

    // Color the card border
    const card = document.getElementById('overall-risk-card');
    const colors = { low: '#10b981', moderate: '#f59e0b', high: '#f97316', critical: '#ef4444' };
    card.style.borderColor = colors[level] || 'var(--border-accent)';
}

function updateVesselCard(vesselId, prediction) {
    const label = document.getElementById(`${vesselId}-label`);
    const prob = document.getElementById(`${vesselId}-prob`);

    if (label) {
        label.textContent = prediction.label;
        label.style.color = getColorForLevel(prediction.risk_level);
    }

    if (prob) {
        prob.textContent = `${(prediction.probability * 100).toFixed(1)}%`;
        prob.style.color = getColorForLevel(prediction.risk_level);
    }

    // Add animation
    const card = document.getElementById(`vessel-${vesselId}`);
    if (card) {
        card.style.borderLeftColor = getColorForLevel(prediction.risk_level);
        card.style.borderLeftWidth = '3px';
        card.classList.add('animate-in');
        setTimeout(() => card.classList.remove('animate-in'), 500);
    }
}

function getColorForLevel(level) {
    const colors = {
        low: '#10b981',
        moderate: '#f59e0b',
        high: '#f97316',
        critical: '#ef4444'
    };
    return colors[level] || '#ffffff';
}

// ─── 3D Visualization Updates ────────────────────────────────────────────────

function update3DVisualization(result) {
    if (!heart3d) return;

    const predictions = result.predictions;

    // Update each artery's risk visualization
    if (predictions.LAD) {
        heart3d.updateRisk('LAD', predictions.LAD.probability);
    }
    if (predictions.LCX) {
        heart3d.updateRisk('LCX', predictions.LCX.probability);
    }
    if (predictions.RCA) {
        heart3d.updateRisk('RCA', predictions.RCA.probability);
    }
}

// ─── SHAP Visualization ─────────────────────────────────────────────────────

function displaySHAPChart(targetKey) {
    const container = document.getElementById('shap-chart');
    if (!currentPrediction || !currentPrediction.shap_explanations) {
        container.innerHTML = '<div class="shap-placeholder"><p>Run analysis to see feature contributions</p></div>';
        return;
    }

    const shapValues = currentPrediction.shap_explanations[targetKey];
    if (!shapValues) {
        container.innerHTML = '<div class="shap-placeholder"><p>No SHAP data for this target</p></div>';
        return;
    }

    // Get top 15 features by absolute SHAP value
    const sorted = Object.entries(shapValues)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 15);

    const maxAbsVal = Math.max(...sorted.map(([, v]) => Math.abs(v)), 0.001);

    let html = '';
    for (const [feature, value] of sorted) {
        const absWidth = (Math.abs(value) / maxAbsVal * 100).toFixed(1);
        const isPositive = value >= 0;
        const barClass = isPositive ? 'positive' : 'negative';
        const sign = isPositive ? '+' : '';
        const valueInPoints = value * 100;

        html += `
            <div class="shap-bar-row">
                <span class="shap-bar-label" title="${feature}">${feature}</span>
                <div class="shap-bar-container">
                    <div class="shap-bar ${barClass}" style="width: ${(Number(absWidth) / 2).toFixed(1)}%; ${isPositive ? 'left: 50%' : 'right: 50%'}"></div>
                </div>
                <span class="shap-bar-value">${sign}${valueInPoints.toFixed(2)} pp</span>
            </div>
        `;
    }

    container.innerHTML = html;
}

// ─── Model Metrics Display ──────────────────────────────────────────────────

function displayModelMetrics() {
    const grid = document.getElementById('metrics-grid');
    if (!metadata || !metadata.results) return;

    const metrics = [
        ['Accuracy', 'accuracy'],
        ['Precision', 'precision'],
        ['Recall', 'recall'],
        ['F1 Score', 'f1'],
        ['ROC-AUC', 'roc_auc']
    ];
    let html = '';
    for (const [target, result] of Object.entries(metadata.results)) {
        const summaries = result.metrics_with_std || {};
        for (const [label, key] of metrics) {
            const summary = summaries[key];
            const mean = summary ? summary.mean : result.metrics[key];
            const deviation = summary && Number.isFinite(summary.std) ? ` ± ${summary.std.toFixed(3)}` : '';
            html += `<div class="metric-item">
                <div class="metric-label">${label}</div>
                <div class="metric-value">${Number(mean || 0).toFixed(3)}${deviation}</div>
                <div class="metric-target">${target}</div>
            </div>`;
        }
    }

    grid.innerHTML = html;
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

function setupEventListeners() {
    // Predict button
    document.getElementById('btn-predict').addEventListener('click', runPrediction);

    // Load sample patient
    document.getElementById('btn-load-sample').addEventListener('click', async () => {
        try {
            const samples = metadata?.sample_patients || [];
            if (!samples.length) throw new Error('No sample patients are bundled with this build.');
            fillFormData(samples[currentSampleIndex]);
            currentSampleIndex = (currentSampleIndex + 1) % samples.length;
        } catch (error) {
            console.error('Error loading sample:', error);
            alert(error.message);
        }
    });

    // Clear form
    document.getElementById('btn-clear-form').addEventListener('click', clearForm);

    // Reset camera
    document.getElementById('btn-reset-camera').addEventListener('click', () => {
        if (heart3d) heart3d.resetCamera();
    });

    // Toggle labels
    document.getElementById('btn-toggle-labels').addEventListener('click', () => {
        if (heart3d) heart3d.toggleLabels();
    });

    // Toggle heartbeat
    document.getElementById('btn-toggle-heartbeat').addEventListener('click', () => {
        if (heart3d) heart3d.toggleHeartbeat();
    });

    // SHAP target selector
    document.getElementById('shap-target-select').addEventListener('change', (e) => {
        if (currentPrediction) {
            displaySHAPChart(e.target.value);
        }
    });

    // Vessel card clicks
    document.querySelectorAll('.vessel-card').forEach(card => {
        card.addEventListener('click', () => {
            const vessel = card.dataset.vessel;
            if (vessel && heart3d) {
                heart3d.highlightArtery(vessel);
                document.querySelectorAll('.vessel-card').forEach(c => c.classList.remove('active'));
                card.classList.add('active');

                // Update SHAP
                const shapSelect = document.getElementById('shap-target-select');
                shapSelect.value = vessel;
                if (currentPrediction) displaySHAPChart(vessel);
            }
        });
        card.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                card.click();
            }
        });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) {
            runPrediction();
        }
    });
}

// ─── CSS for spinner ─────────────────────────────────────────────────────────

const style = document.createElement('style');
style.textContent = `
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;
document.head.appendChild(style);

// ─── Start Application ──────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
