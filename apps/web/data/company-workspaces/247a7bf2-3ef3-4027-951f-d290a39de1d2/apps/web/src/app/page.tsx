import DemoRequestForm from '@/components/DemoRequestForm'

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            Tourbillon
          </h1>
          <p className="text-xl text-gray-600 mb-8">
            Plan your perfect tour with ease
          </p>
        </div>

        <DemoRequestForm />
      </div>
    </main>
  )
}
