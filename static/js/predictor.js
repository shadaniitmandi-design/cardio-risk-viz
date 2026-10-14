/**
 * Small browser-side XGBoost runtime for the exported binary tree models.
 * SHAP values are approximated with deterministic random permutations and are
 * expressed as changes in probability (percentage-point contributions).
 */

const TARGETS = ['Cath', 'LAD', 'LCX', 'RCA'];
const PERMUTATION_COUNT = 24;
let modelPromise;

export function loadPredictorModels() {
    if (!modelPromise) {
        modelPromise = Promise.all(TARGETS.map(async (target) => {
            const response = await fetch(new URL(`../ml/${target}.json`, import.meta.url));
            if (!response.ok) throw new Error(`Could not load the ${target} model.`);
            const model = await response.json();
            return [target, model];
        })).then((entries) => Object.fromEntries(entries));
    }
    return modelPromise;
}

function getTrees(bundle) {
    const learner = bundle.booster.learner;
    const model = learner.gradient_booster?.model;
    if (!model?.trees?.length) throw new Error(`The ${bundle.target} model has no trees.`);
    if (learner.gradient_booster.name !== 'gbtree') {
        throw new Error(`The ${bundle.target} model is not a supported tree booster.`);
    }
    const baseScore = Number(String(learner.learner_model_param.base_score).match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/)?.[0]);
    if (!(baseScore > 0 && baseScore < 1)) throw new Error(`The ${bundle.target} model has an invalid base score.`);
    return { trees: model.trees, baseMargin: Math.log(baseScore / (1 - baseScore)) };
}

function sigmoid(value) {
    if (value >= 0) return 1 / (1 + Math.exp(-value));
    const expValue = Math.exp(value);
    return expValue / (1 + expValue);
}

function createScorer(bundle) {
    const { trees, baseMargin } = getTrees(bundle);
    const score = (features) => {
        let margin = baseMargin;
        for (const tree of trees) {
            let node = 0;
            while (tree.left_children[node] !== -1) {
                const featureIndex = tree.split_indices[node];
                const value = features[featureIndex];
                if (!Number.isFinite(value)) {
                    node = tree.default_left[node] ? tree.left_children[node] : tree.right_children[node];
                } else {
                    node = value < Math.fround(tree.split_conditions[node])
                        ? tree.left_children[node]
                        : tree.right_children[node];
                }
            }
            margin += Math.fround(tree.split_conditions[node]);
        }
        return sigmoid(margin);
    };
    return score;
}

function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

function makeSeed(features, targetIndex) {
    let seed = (0x9e3779b9 ^ (targetIndex + 1)) >>> 0;
    for (const value of features) {
        const quantized = Number.isFinite(value) ? Math.round(value * 1000) : 0;
        seed = (Math.imul(seed ^ quantized, 2246822519) + 3266489917) >>> 0;
    }
    return seed;
}

function permutationValues(score, features, targetIndex) {
    const contributions = new Float64Array(features.length);
    const coalition = new Float64Array(features.length);
    const random = seededRandom(makeSeed(features, targetIndex));
    const order = Array.from({ length: features.length }, (_, index) => index);
    const baseline = score(coalition);

    for (let sample = 0; sample < PERMUTATION_COUNT; sample++) {
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }

        coalition.fill(0);
        let previous = baseline;
        for (const featureIndex of order) {
            coalition[featureIndex] = features[featureIndex];
            const current = score(coalition);
            contributions[featureIndex] += current - previous;
            previous = current;
        }
    }

    return Object.fromEntries(features.map((_, index) => [
        index,
        Math.round((contributions[index] / PERMUTATION_COUNT) * 1e6) / 1e6
    ]));
}

function riskLevel(probability) {
    if (probability < 0.25) return 'low';
    if (probability < 0.5) return 'moderate';
    if (probability < 0.75) return 'high';
    return 'critical';
}

export function predictPatient(input, metadata, loadedModels) {
    if (!metadata?.feature_names?.length) throw new Error('The clinical feature schema is unavailable.');

    const models = loadedModels;
    if (!models) throw new Error('Prediction models are still loading. Please try again.');

    const names = metadata.feature_names;
    const rawValues = names.map((name) => {
        const supplied = Number(input[name]);
        return Number.isFinite(supplied)
            ? supplied
            : Number(metadata.feature_stats?.[name]?.mean) || 0;
    });
    const predictions = {};
    const shapExplanations = {};

    TARGETS.forEach((target, targetIndex) => {
        const bundle = models[target];
        if (!bundle || bundle.scaler.mean.length !== names.length || bundle.scaler.scale.length !== names.length) {
            throw new Error(`The ${target} model does not match the clinical feature schema.`);
        }
        const scaled = rawValues.map((value, index) => {
            const scale = bundle.scaler.scale[index];
            // XGBoost ingests feature matrices as float32. Match that cast
            // before tree traversal so values on a split boundary take the
            // same branch as the Python model.
            return scale ? Math.fround((value - bundle.scaler.mean[index]) / scale) : 0;
        });
        const score = createScorer(bundle);
        const probability = score(scaled);
        const predictedClass = probability >= 0.5 ? 1 : 0;
        const level = riskLevel(probability);

        predictions[target] = {
            class: predictedClass,
            probability: Number(probability.toFixed(4)),
            risk_level: level,
            label: target === 'Cath'
                ? (predictedClass ? 'CAD' : 'No CAD')
                : (predictedClass ? 'Stenosis' : 'Normal')
        };

        const featureContributions = permutationValues(score, scaled, targetIndex);
        shapExplanations[target] = Object.fromEntries(names.map((name, index) => [
            name,
            featureContributions[index]
        ]));
    });

    return {
        predictions,
        shap_explanations: shapExplanations,
        overall_risk: predictions.Cath.probability,
        overall_risk_level: predictions.Cath.risk_level,
        input_features: Object.fromEntries(names.map((name, index) => [name, rawValues[index]])),
        missing_features: names.filter((name) => !Number.isFinite(Number(input[name])))
    };
}
