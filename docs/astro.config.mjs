// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://lovato.github.io',
	base: '/streamdeck-auto-profile-switcher/',
	integrations: [
		starlight({
			title: 'Auto Profile Switcher',
			description:
				'Stream Deck plugin for MSIX app detection, window title matching, and smart profile switching on Windows.',
			logo: {
				src: './src/assets/logo.png',
				alt: 'Auto Profile Switcher',
			},
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/lovato/streamdeck-auto-profile-switcher',
				},
			],
			editLink: {
				baseUrl:
					'https://github.com/lovato/streamdeck-auto-profile-switcher/edit/dev/docs/',
			},
			customCss: ['./src/styles/custom.css'],
			head: [
				{
					tag: 'link',
					attrs: {
						rel: 'icon',
						href: '/streamdeck-auto-profile-switcher/favicon.png',
						type: 'image/png',
					},
				},
			],
			sidebar: [
				{
					label: 'Getting started',
					items: [
						{ label: 'Overview', slug: 'getting-started' },
						{ label: 'Installation', slug: 'getting-started/installation' },
						{ label: 'Quick start', slug: 'getting-started/quickstart' },
					],
				},
				{
					label: 'Features',
					items: [
						{ label: 'Overview', slug: 'features' },
						{ label: 'MSIX / WindowsApps', slug: 'features/msix-apps' },
						{ label: 'Window title matching', slug: 'features/title-matching' },
						{ label: 'Hybrid Smart Profiles', slug: 'features/smart-profiles' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Adding rules', slug: 'guides/adding-rules' },
						{ label: 'Test detection', slug: 'guides/test-detection' },
						{ label: 'Patching profiles', slug: 'guides/patching-profiles' },
					],
				},
				{
					label: 'Developer',
					items: [
						{ label: 'Overview', slug: 'developer' },
						{ label: 'Setup', slug: 'developer/setup' },
						{ label: 'Architecture', slug: 'developer/architecture' },
						{ label: 'Task runner', slug: 'developer/tasks' },
						{ label: 'Releases', slug: 'developer/releases' },
					],
				},
			],
		}),
	],
});
