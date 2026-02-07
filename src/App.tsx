import React from 'react'

const Trumpedia = () => {
  return (
    <div className="min-h-screen bg-white text-[#202122] font-serif">
      {/* Header */}
      <header className="border-b border-[#a2a9b1] px-4 py-2 flex items-center justify-between sticky top-0 bg-white z-10">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-[#c8102e] rounded-full flex items-center justify-center text-white font-bold text-xl">
            T
          </div>
          <h1 className="text-2xl font-normal">Trumpedia</h1>
        </div>
        <div className="flex-1 max-w-2xl px-8">
          <div className="relative">
            <input
              type="text"
              placeholder="Search Trumpedia"
              className="w-full border border-[#a2a9b1] px-3 py-1 text-sm focus:outline-none focus:border-[#3366cc]"
            />
            <button className="absolute right-0 top-0 bottom-0 px-3 bg-[#f8f9fa] border-l border-[#a2a9b1] hover:bg-[#eee] text-sm">
              Search
            </button>
          </div>
        </div>
        <div className="flex gap-4 text-sm text-[#3366cc]">
          <a href="#" className="hover:underline">Create account</a>
          <a href="#" className="hover:underline">Log in</a>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <aside className="w-44 p-4 text-sm border-r border-transparent flex flex-col gap-4 sticky top-14 h-[calc(100vh-3.5rem)]">
          <section>
            <h2 className="text-[#54595d] border-b border-[#a2a9b1] mb-2 uppercase text-[0.75rem] font-bold">Main menu</h2>
            <ul className="flex flex-col gap-1 text-[#3366cc]">
              <li><a href="#" className="hover:underline">Main page</a></li>
              <li><a href="#" className="hover:underline">Contents</a></li>
              <li><a href="#" className="hover:underline">Current events</a></li>
              <li><a href="#" className="hover:underline">Random article</a></li>
              <li><a href="#" className="hover:underline">About Trumpedia</a></li>
            </ul>
          </section>
          <section>
            <h2 className="text-[#54595d] border-b border-[#a2a9b1] mb-2 uppercase text-[0.75rem] font-bold">Contribute</h2>
            <ul className="flex flex-col gap-1 text-[#3366cc]">
              <li><a href="#" className="hover:underline">Help</a></li>
              <li><a href="#" className="hover:underline">Community portal</a></li>
              <li><a href="#" className="hover:underline">Recent changes</a></li>
              <li><a href="#" className="hover:underline">Upload file</a></li>
            </ul>
          </section>
        </aside>

        {/* Main Content */}
        <main className="flex-1 p-8 max-w-5xl">
          <div className="border-b border-[#a2a9b1] mb-6 flex items-baseline justify-between">
            <h1 className="text-4xl font-normal mb-1">Donald Trump</h1>
            <div className="text-sm text-[#3366cc] flex gap-4">
              <a href="#" className="hover:underline border-b-2 border-[#3366cc] pb-1 font-bold">Article</a>
              <a href="#" className="hover:underline">Talk</a>
            </div>
          </div>

          <div className="flex flex-col md:flex-row gap-8">
            <div className="flex-1">
              <p className="mb-4 italic text-sm text-[#54595d]">From Trumpedia, the free encyclopedia of the 45th and 47th President.</p>
              
              <p className="mb-4 leading-relaxed">
                <span className="font-bold">Donald John Trump</span> (born June 14, 1946) is an American politician, media personality, and businessman who is the 47th and current president of the United States. He previously served as the 45th president from 2017 to 2021.
              </p>

              <p className="mb-4 leading-relaxed">
                Trump was born and raised in Queens, New York City. He graduated from the Wharton School of the University of Pennsylvania with a bachelor's degree in 1968. He became president of his father Fred Trump's real estate business in 1971 and renamed it The Trump Organization. He expanded its operations to building and renovating skyscrapers, hotels, casinos, and golf courses.
              </p>

              <h2 className="text-2xl border-b border-[#a2a9b1] mt-8 mb-4 font-normal">History</h2>
              <p className="mb-4 leading-relaxed">
                Trump's political career began in 2015 when he announced his candidacy for the presidency as a Republican. His campaign was characterized by its focus on "Making America Great Again" (MAGA) and its unconventional style.
              </p>
            </div>

            {/* Infobox */}
            <aside className="w-full md:w-80 border border-[#a2a9b1] bg-[#f8f9fa] p-2 text-sm shrink-0 h-fit">
              <h2 className="text-center font-bold text-lg mb-2">Donald Trump</h2>
              <div className="bg-white border border-[#a2a9b1] p-1 mb-2">
                <div className="bg-[#eee] aspect-[3/4] flex items-center justify-center text-[#999]">
                   {/* Placeholder for official portrait */}
                   Official Portrait
                </div>
              </div>
              <table className="w-full text-[0.8rem]">
                <tbody>
                  <tr className="border-t border-[#a2a9b1]">
                    <th className="text-left py-1 pr-2 w-1/3">Born</th>
                    <td className="py-1">June 14, 1946<br/>Queens, New York City</td>
                  </tr>
                  <tr className="border-t border-[#a2a9b1]">
                    <th className="text-left py-1 pr-2">Political party</th>
                    <td className="py-1">Republican</td>
                  </tr>
                  <tr className="border-t border-[#a2a9b1]">
                    <th className="text-left py-1 pr-2">Alma mater</th>
                    <td className="py-1">University of Pennsylvania (BA)</td>
                  </tr>
                  <tr className="border-t border-[#a2a9b1]">
                    <th className="text-left py-1 pr-2">Spouse(s)</th>
                    <td className="py-1">Ivana Zelníčková (m. 1977; div. 1992)<br/>Marla Maples (m. 1993; div. 1999)<br/>Melania Knauss (m. 2005)</td>
                  </tr>
                </tbody>
              </table>
              <div className="mt-4 bg-[#c8102e] text-white text-center py-1 font-bold">
                MAGA
              </div>
            </aside>
          </div>
        </main>
      </div>
    </div>
  )
}

export default Trumpedia
