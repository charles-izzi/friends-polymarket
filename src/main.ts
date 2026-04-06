import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createVuetify } from 'vuetify'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'

import App from './App.vue'
import router from './router'
import { useAuthStore } from './stores/auth'

const app = createApp(App)
const pinia = createPinia()
const vuetify = createVuetify({
  theme: {
    defaultTheme: 'dark',
    themes: {
      dark: {
        dark: true,
        colors: {
          background: '#121212',
          surface: '#1E1E1E',
          'surface-bright': '#2A2A2A',
          'surface-variant': '#333333',
          primary: '#66DD55',
          'primary-darken-1': '#4CAF50',
          secondary: '#10B8E6',
          'secondary-darken-1': '#0D93B8',
          accent: '#E6A810',
          error: '#E6434F',
          warning: '#E6A810',
          info: '#10B8E6',
          success: '#4CE660',
          'on-background': '#E0E0E0',
          'on-surface': '#E0E0E0',
          'on-surface-variant': '#FFFFFF',
          'on-primary': '#1A1A1A',
          'on-secondary': '#1A1A1A',
        },
      },
    },
  },
})

app.use(pinia)
app.use(vuetify)
app.use(router)

const authStore = useAuthStore()
authStore.init().then(() => {
  app.mount('#app')
})
