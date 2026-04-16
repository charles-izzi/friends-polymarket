import { useRouter } from 'vue-router'

export function useSmartBack(fallbackRoute: string) {
  const router = useRouter()

  function goBack() {
    if (window.history.state?.back) {
      router.back()
    } else {
      router.push(fallbackRoute)
    }
  }

  return { goBack }
}
