/**
 * CardioViz AI - 3D Heart Visualization Module
 * =============================================
 * Creates an interactive 3D heart model with coronary arteries (LAD, LCX, RCA)
 * using Three.js. Supports dynamic risk-based color coding, heartbeat animation,
 * and interactive artery selection.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ─── Risk Color Utilities ─────────────────────────────────────────────────────

function getRiskColor(probability) {
    if (probability < 0.25) return new THREE.Color(0x10b981);       // Green - Low
    if (probability < 0.50) return new THREE.Color(0xf59e0b);       // Amber - Moderate
    if (probability < 0.75) return new THREE.Color(0xf97316);       // Orange - High
    return new THREE.Color(0xef4444);                                // Red - Critical
}

function lerpColor(color1, color2, t) {
    return new THREE.Color().lerpColors(color1, color2, t);
}

const ANATOMICAL_HEART_URL = new URL('../models/heart.glb', import.meta.url).href;

// ─── Heart 3D Visualization Class ─────────────────────────────────────────────

export class Heart3D {
    constructor(container) {
        this.container = container;
        this.arteries = {};
        this.arteryMeshes = {};
        this.labels = {};
        this.particles = [];
        this.heartGroup = new THREE.Group();
        this.heartbeatEnabled = true;
        this.labelsVisible = true;
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.selectedArtery = null;
        this.hoveredArtery = null;
        this.clock = new THREE.Clock();
        this.riskValues = { LAD: 0, LCX: 0, RCA: 0 };
        this.heartModel = null;
        this.modelBaseScale = 1;
        this.modelBasePosition = new THREE.Vector3();
        this.modelReady = false;

        this._onMouseMove = this._onMouseMove.bind(this);
        this._onClick = this._onClick.bind(this);
        this._onResize = this._onResize.bind(this);

        this.init();
    }

    init() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;

        // Scene
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0xf0eee6, 0.008);

        // Camera
        this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
        this.camera.position.set(0, 1, 7);
        this.camera.lookAt(0, 0, 0);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: true,
            powerPreference: 'high-performance'
        });
        this.renderer.setSize(w, h);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.2;
        this.container.appendChild(this.renderer.domElement);

        // Controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.minDistance = 3;
        this.controls.maxDistance = 15;
        this.controls.autoRotate = false;
        this.controls.target.set(0, 0, 0);

        // Lighting
        this._setupLighting();

        // Load the textured, anatomical heart model, then layer the risk map on top.
        this._createArteries();
        this._loadAnatomicalHeart();

        this.scene.add(this.heartGroup);

        // Events
        this.container.addEventListener('mousemove', this._onMouseMove);
        this.container.addEventListener('click', this._onClick);
        window.addEventListener('resize', this._onResize);

        // Start animation loop
        this._animate();
    }

    _setupLighting() {
        // Ambient light
        const ambient = new THREE.AmbientLight(0x9a9a91, 0.72);
        this.scene.add(ambient);

        // Main directional light
        const mainLight = new THREE.DirectionalLight(0xffffff, 1.0);
        mainLight.position.set(5, 8, 5);
        mainLight.castShadow = false;
        this.scene.add(mainLight);

        // Fill light
        const fillLight = new THREE.DirectionalLight(0xb9b1a3, 0.28);
        fillLight.position.set(-5, 2, -3);
        this.scene.add(fillLight);

        // Rim light
        const rimLight = new THREE.DirectionalLight(0x0ea5e9, 0.12);
        rimLight.position.set(0, -3, -5);
        this.scene.add(rimLight);

    }

    _loadAnatomicalHeart() {
        const status = document.getElementById('anatomy-model-status');
        const loader = new GLTFLoader();

        loader.load(
            ANATOMICAL_HEART_URL,
            (gltf) => {
                const model = gltf.scene;

                model.traverse((node) => {
                    if (!node.isMesh) return;

                    node.castShadow = true;
                    node.receiveShadow = true;
                    node.userData.isAnatomicalHeart = true;

                    const materials = Array.isArray(node.material) ? node.material : [node.material];
                    materials.forEach((material) => {
                        if (!material) return;
                        material.side = THREE.FrontSide;
                        material.needsUpdate = true;
                    });
                });

                // Normalize the downloaded asset so it occupies the same readable
                // stage as the vessel overlays on every screen size.
                model.updateMatrixWorld(true);
                const bounds = new THREE.Box3().setFromObject(model);
                const center = bounds.getCenter(new THREE.Vector3());
                const size = bounds.getSize(new THREE.Vector3());
                const largestDimension = Math.max(size.x, size.y, size.z);
                const targetDimension = 4.25;

                model.position.sub(center);
                this.modelBaseScale = targetDimension / largestDimension;
                model.scale.setScalar(this.modelBaseScale);
                this.modelBasePosition.copy(model.position);

                this.heartModel = model;
                this.heartMesh = model;
                this.modelReady = true;
                this.heartGroup.add(model);

                if (status) {
                    status.classList.add('loaded');
                    status.innerHTML = '<span class="status-dot"></span>Real anatomical model loaded';
                }
            },
            undefined,
            (error) => {
                console.error('Anatomical heart model failed to load:', error);
                this._createFallbackHeart();
                if (status) {
                    status.classList.add('error');
                    status.textContent = 'Anatomical model unavailable';
                }
            }
        );
    }

    _createFallbackHeart() {
        // Keep the viewer usable if a static asset is unavailable, without
        // silently reverting to the old flat heart icon.
        const fallback = new THREE.Group();
        const tissue = new THREE.MeshPhysicalMaterial({
            color: 0x8f2433,
            roughness: 0.56,
            clearcoat: 0.25,
            clearcoatRoughness: 0.45,
        });
        const lobeGeometry = new THREE.SphereGeometry(1.25, 32, 24);
        const leftLobe = new THREE.Mesh(lobeGeometry, tissue);
        const rightLobe = new THREE.Mesh(lobeGeometry, tissue);
        leftLobe.position.set(-0.62, 0.25, 0);
        rightLobe.position.set(0.62, 0.1, 0.05);
        rightLobe.scale.set(0.9, 1.05, 0.94);

        const apex = new THREE.Mesh(new THREE.ConeGeometry(0.95, 2.3, 32), tissue);
        apex.position.set(0.1, -1.15, 0.02);
        apex.rotation.z = Math.PI;
        fallback.add(leftLobe, rightLobe, apex);
        fallback.scale.setScalar(1.05);
        this.modelBaseScale = 1.05;
        this.heartModel = fallback;
        this.heartMesh = fallback;
        this.modelReady = true;
        this.heartGroup.add(fallback);
    }

    _createArteries() {
        // LAD - Left Anterior Descending: runs along the front of the heart, top to bottom
        const ladPoints = [
            new THREE.Vector3(0.0, 1.35, 0.82),
            new THREE.Vector3(-0.14, 0.95, 1.02),
            new THREE.Vector3(-0.25, 0.4, 1.02),
            new THREE.Vector3(-0.28, -0.2, 0.94),
            new THREE.Vector3(-0.22, -0.72, 0.78),
            new THREE.Vector3(-0.14, -1.18, 0.62),
            new THREE.Vector3(-0.08, -1.42, 0.48),
        ];

        // LCX - Left Circumflex: wraps around the left side and back
        const lcxPoints = [
            new THREE.Vector3(0.0, 1.28, 0.74),
            new THREE.Vector3(-0.38, 1.08, 0.58),
            new THREE.Vector3(-0.75, 0.86, 0.3),
            new THREE.Vector3(-1.05, 0.5, 0.0),
            new THREE.Vector3(-1.12, 0.05, -0.32),
            new THREE.Vector3(-0.95, -0.36, -0.5),
            new THREE.Vector3(-0.72, -0.65, -0.5),
        ];

        // RCA - Right Coronary Artery: runs down the right side
        const rcaPoints = [
            new THREE.Vector3(0.38, 1.4, 0.66),
            new THREE.Vector3(0.66, 1.18, 0.5),
            new THREE.Vector3(0.95, 0.84, 0.3),
            new THREE.Vector3(1.15, 0.42, 0.03),
            new THREE.Vector3(1.12, 0.0, -0.24),
            new THREE.Vector3(0.95, -0.42, -0.4),
            new THREE.Vector3(0.72, -0.7, -0.3),
        ];

        const arteryDefs = {
            LAD: { points: ladPoints, color: 0x91a8b8, name: 'LAD (Left Anterior Descending)' },
            LCX: { points: lcxPoints, color: 0x91a8b8, name: 'LCX (Left Circumflex)' },
            RCA: { points: rcaPoints, color: 0x91a8b8, name: 'RCA (Right Coronary Artery)' },
        };

        for (const [key, def] of Object.entries(arteryDefs)) {
            const curve = new THREE.CatmullRomCurve3(def.points, false, 'catmullrom', 0.5);
            const tubeGeometry = new THREE.TubeGeometry(curve, 64, 0.055, 12, false);

            const material = new THREE.MeshPhysicalMaterial({
                color: def.color,
                emissive: new THREE.Color(def.color).multiplyScalar(0.04),
                metalness: 0.04,
                roughness: 0.68,
                clearcoat: 0.08,
                transparent: true,
                opacity: 0.95,
                depthTest: false,
            });

            const mesh = new THREE.Mesh(tubeGeometry, material);
            mesh.renderOrder = 10;
            mesh.userData = { arteryKey: key, arteryName: def.name, baseColor: def.color };
            this.heartGroup.add(mesh);
            this.arteryMeshes[key] = mesh;
            this.arteries[key] = { curve, material, def, mesh };

            // Glow tube
            const glowMat = new THREE.MeshBasicMaterial({
                color: def.color,
                transparent: true,
                opacity: 0.035,
                depthTest: false,
                side: THREE.BackSide
            });
            const glowTube = new THREE.Mesh(
                new THREE.TubeGeometry(curve, 64, 0.095, 12, false),
                glowMat
            );
            glowTube.renderOrder = 9;
            glowTube.userData = { isGlow: true, arteryKey: key };
            this.heartGroup.add(glowTube);
            this.arteries[key].glowMesh = glowTube;
            this.arteries[key].glowMaterial = glowMat;

            // Label sprite
            this._createLabel(key, def.name.split('(')[0].trim(), def.points[Math.floor(def.points.length / 2)], def.color);
        }
    }

    _createLabel(key, text, position, color) {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');

        // Background
        ctx.fillStyle = 'rgba(6, 6, 19, 0.8)';
        ctx.roundRect(0, 0, 256, 64, 10);
        ctx.fill();

        // Border
        ctx.strokeStyle = `#${new THREE.Color(color).getHexString()}`;
        ctx.lineWidth = 2;
        ctx.roundRect(2, 2, 252, 60, 8);
        ctx.stroke();

        // Text
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 24px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 128, 32);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;

        const spriteMat = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            opacity: 0.9,
            depthTest: false
        });
        const sprite = new THREE.Sprite(spriteMat);
        sprite.position.copy(position);
        sprite.position.x += (key === 'RCA' ? 0.28 : key === 'LCX' ? -0.28 : -0.28);
        sprite.position.y += 0.24;
        sprite.scale.set(0.95, 0.24, 1);
        this.heartGroup.add(sprite);
        this.labels[key] = sprite;
    }

    _createParticles() {
        // Blood flow particle system
        const particleCount = 200;
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(particleCount * 3);
        const colors = new Float32Array(particleCount * 3);
        const sizes = new Float32Array(particleCount);

        for (let i = 0; i < particleCount; i++) {
            // Random position around heart
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.random() * Math.PI;
            const r = 2.5 + Math.random() * 2;

            positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
            positions[i * 3 + 2] = r * Math.cos(phi);

            // Red-ish particles
            colors[i * 3] = 0.8 + Math.random() * 0.2;
            colors[i * 3 + 1] = 0.1 + Math.random() * 0.1;
            colors[i * 3 + 2] = 0.1 + Math.random() * 0.15;

            sizes[i] = Math.random() * 3 + 1;
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

        const material = new THREE.PointsMaterial({
            size: 0.03,
            vertexColors: true,
            transparent: true,
            opacity: 0.4,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            sizeAttenuation: true
        });

        this.particleSystem = new THREE.Points(geometry, material);
        this.scene.add(this.particleSystem);
    }

    // ─── Update Methods ──────────────────────────────────────

    updateRisk(arteryKey, probability) {
        if (!this.arteries[arteryKey]) return;

        this.riskValues[arteryKey] = probability;
        const color = getRiskColor(probability);
        const artery = this.arteries[arteryKey];

        // Animate color transition
        artery.material.color.copy(color);
        artery.material.emissive.copy(color).multiplyScalar(0.08 + probability * 0.12);
        artery.glowMaterial.color.copy(color);
        artery.glowMaterial.opacity = 0.035 + probability * 0.075;

        // Update label
        this._updateLabel(arteryKey, probability, color);
    }

    _updateLabel(key, probability, color) {
        if (!this.labels[key]) return;

        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 80;
        const ctx = canvas.getContext('2d');

        // Background
        ctx.fillStyle = 'rgba(8, 11, 16, 0.94)';
        ctx.rect(0, 0, 256, 80);
        ctx.fill();

        // Border with risk color
        ctx.strokeStyle = `#${color.getHexString()}`;
        ctx.lineWidth = 2;
        ctx.rect(1, 1, 254, 78);
        ctx.stroke();

        // Title
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 20px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(key, 128, 28);

        // Probability
        ctx.fillStyle = `#${color.getHexString()}`;
        ctx.font = 'bold 22px JetBrains Mono, monospace';
        ctx.fillText(`${(probability * 100).toFixed(1)}%`, 128, 58);

        const texture = new THREE.CanvasTexture(canvas);
        this.labels[key].material.map = texture;
        this.labels[key].material.needsUpdate = true;
    }

    highlightArtery(arteryKey) {
        for (const [key, artery] of Object.entries(this.arteries)) {
            if (key === arteryKey) {
                artery.material.opacity = 1.0;
                artery.glowMaterial.opacity = 0.08;
                artery.mesh.scale.set(1.3, 1.3, 1.3);
            } else {
                artery.material.opacity = 0.5;
                artery.glowMaterial.opacity = 0.015;
                artery.mesh.scale.set(1, 1, 1);
            }
        }
    }

    resetHighlight() {
        for (const [key, artery] of Object.entries(this.arteries)) {
            artery.material.opacity = 0.95;
            artery.glowMaterial.opacity = 0.035 + this.riskValues[key] * 0.075;
            artery.mesh.scale.set(1, 1, 1);
        }
    }

    toggleHeartbeat() {
        this.heartbeatEnabled = !this.heartbeatEnabled;
        return this.heartbeatEnabled;
    }

    toggleLabels() {
        this.labelsVisible = !this.labelsVisible;
        for (const sprite of Object.values(this.labels)) {
            sprite.visible = this.labelsVisible;
        }
        return this.labelsVisible;
    }

    resetCamera() {
        this.camera.position.set(0, 1, 7);
        this.camera.lookAt(0, 0, 0);
        this.controls.target.set(0, 0, 0);
        this.controls.update();
    }

    // ─── Event Handlers ──────────────────────────────────────

    _onMouseMove(event) {
        const rect = this.container.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        // Raycast for artery hover
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const meshes = Object.values(this.arteryMeshes);
        const intersects = this.raycaster.intersectObjects(meshes);

        const tooltip = document.getElementById('artery-tooltip');

        if (intersects.length > 0) {
            const hit = intersects[0].object;
            const key = hit.userData.arteryKey;

            if (key && this.hoveredArtery !== key) {
                this.hoveredArtery = key;
                this.container.style.cursor = 'pointer';

                // Show tooltip
                if (tooltip) {
                    const prob = this.riskValues[key] || 0;
                    const color = getRiskColor(prob);
                    document.getElementById('tooltip-title').textContent = this.arteries[key].def.name;
                    const valEl = document.getElementById('tooltip-value');
                    valEl.textContent = `${(prob * 100).toFixed(1)}%`;
                    valEl.style.color = `#${color.getHexString()}`;
                    tooltip.style.display = 'block';
                    tooltip.style.left = `${event.clientX - this.container.getBoundingClientRect().left + 15}px`;
                    tooltip.style.top = `${event.clientY - this.container.getBoundingClientRect().top - 10}px`;
                }
            } else if (tooltip && key) {
                tooltip.style.left = `${event.clientX - this.container.getBoundingClientRect().left + 15}px`;
                tooltip.style.top = `${event.clientY - this.container.getBoundingClientRect().top - 10}px`;
            }
        } else {
            if (this.hoveredArtery) {
                this.hoveredArtery = null;
                this.container.style.cursor = 'grab';
                if (tooltip) tooltip.style.display = 'none';
            }
        }
    }

    _onClick(event) {
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const meshes = Object.values(this.arteryMeshes);
        const intersects = this.raycaster.intersectObjects(meshes);

        if (intersects.length > 0) {
            const key = intersects[0].object.userData.arteryKey;
            if (key) {
                this.selectedArtery = key;
                this.highlightArtery(key);

                // Dispatch custom event
                window.dispatchEvent(new CustomEvent('artery-selected', { detail: { arteryKey: key } }));
            }
        } else {
            this.selectedArtery = null;
            this.resetHighlight();
            window.dispatchEvent(new CustomEvent('artery-deselected'));
        }
    }

    _onResize() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

    // ─── Animation Loop ──────────────────────────────────────

    _animate() {
        requestAnimationFrame(() => this._animate());

        const elapsed = this.clock.getElapsedTime();
        const delta = this.clock.getDelta();

        // Heartbeat animation
        if (this.heartbeatEnabled && this.heartModel) {
            const beat = 1 + Math.sin(elapsed * 4) * 0.02 + Math.sin(elapsed * 8) * 0.01;
            this.heartModel.scale.setScalar(this.modelBaseScale * beat);
        }

        // Gentle rotation for arteries glow
        for (const artery of Object.values(this.arteries)) {
            if (artery.glowMaterial) {
                const pulse = Math.sin(elapsed * 3) * 0.008;
                artery.glowMaterial.opacity = Math.max(0.05,
                    (artery.glowMaterial.opacity || 0.035) + pulse
                );
            }
        }

        // Particle animation
        if (this.particleSystem) {
            const positions = this.particleSystem.geometry.attributes.position.array;
            for (let i = 0; i < positions.length; i += 3) {
                positions[i] += Math.sin(elapsed + i) * 0.001;
                positions[i + 1] += Math.cos(elapsed + i * 0.5) * 0.001;
                positions[i + 2] += Math.sin(elapsed * 0.5 + i) * 0.001;
            }
            this.particleSystem.geometry.attributes.position.needsUpdate = true;
            this.particleSystem.rotation.y = elapsed * 0.05;
        }

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    // ─── Cleanup ─────────────────────────────────────────────

    dispose() {
        this.container.removeEventListener('mousemove', this._onMouseMove);
        this.container.removeEventListener('click', this._onClick);
        window.removeEventListener('resize', this._onResize);
        this.renderer.dispose();
    }
}
