import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://docs.oakgreen.cc',
  integrations: [
    starlight({
      title: 'oakgreen.cc',
      description: 'Run coding agents against a GitHub repository, with GitHub as the source of truth.',
      favicon: '/favicon.svg',
      head: [{ tag: 'meta', attrs: { name: 'theme-color', content: '#0b190f' } }],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/oakgreencc/monorepo' }],
      editLink: { baseUrl: 'https://github.com/oakgreencc/monorepo/edit/main/docs/' },
      customCss: ['./src/styles/oakgreen.css'],
      components: {
        SiteTitle: './src/components/SiteTitle.astro',
        Hero: './src/components/Hero.astro',
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
      expressiveCode: {
        themes: ['everforest-dark', 'everforest-light'],
        styleOverrides: {
          borderRadius: '0.625rem',
          borderColor: 'var(--sl-color-hairline-light)',
          codeBackground: ({ theme }) => (theme.type === 'dark' ? '#0f2116' : '#eef3eb'),
          frames: {
            editorTabBarBackground: ({ theme }) => (theme.type === 'dark' ? '#0d1d12' : '#e3ebe2'),
            editorActiveTabBackground: ({ theme }) => (theme.type === 'dark' ? '#0f2116' : '#eef3eb'),
            terminalTitlebarBackground: ({ theme }) => (theme.type === 'dark' ? '#0d1d12' : '#e3ebe2'),
            terminalBackground: ({ theme }) => (theme.type === 'dark' ? '#0f2116' : '#eef3eb'),
            frameBoxShadowCssValue: 'none',
          },
        },
      },
      sidebar: [
        { label: 'Tutorials', items: [{ autogenerate: { directory: 'tutorials' } }] },
        { label: 'How-to guides', items: [{ autogenerate: { directory: 'how-to' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
        { label: 'Explanation', items: [{ autogenerate: { directory: 'explanation' } }] },
      ],
    }),
  ],
})
