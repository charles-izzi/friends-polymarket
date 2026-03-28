<script setup lang="ts">
import { RouterView } from 'vue-router'
</script>

<template>
  <v-app>
    <v-app-bar density="compact" color="primary">
      <v-app-bar-title>
        <router-link to="/" class="text-white text-decoration-none">Friends Polymarket</router-link>
      </v-app-bar-title>
    </v-app-bar>
    <v-main>
      <RouterView />
    </v-main>
  </v-app>
</template>
